/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/* eslint-disable import/prefer-default-export */
import Prisma, { PrismaClient } from "@prisma/client";
import { ErrorWithCause } from "pony-cause";
import GatewayDEPRECATED from "../alpha-models/Gateway";
import ReadingDEPRECATED from "../alpha-models/readings/Reading";
import NodeDEPRECATED from "../alpha-models/Node";
import {
  DataProvider,
  QueryResult,
  QueryHistoricalReadings,
  BulkImport,
} from "../DataProvider";
import {
  ProjectID,
  ProjectReadingsSnapshot,
  SensorHost,
  SensorHostReadingsSnapshot,
  SensorType,
  Reading,
  ProjectHistoricalData,
} from "../DomainModel";
import Mapper from "./PrismaDomainModelMapper";
import {
  serverLogError,
  serverLogInfo,
  serverLogProgress,
} from "../../pages/api/log";
import { NotehubAccessor } from "../notehub/NotehubAccessor";
import { SparrowEventHandler } from "../SparrowEvent";
import { sparrowEventFromNotehubEvent } from "../notehub/SparrowEvents";
import NotehubDataProvider from "../notehub/NotehubDataProvider";
import { gatewayTransformUpsert, nodeTransformUpsert } from "./importTransform";
import { ERROR_CODES, getError } from "../Errors";

// Todo: Should be dependency injected?
async function manageGatewayImport(
  bi: BulkImport,
  p: PrismaClient,
  project: Prisma.Project,
  gateway: GatewayDEPRECATED
) {
  const b = bi;
  serverLogInfo("gateway import", gateway.name, gateway.uid);
  try {
    b.itemCount += 1;
    await p.gateway.upsert(gatewayTransformUpsert(gateway, project));
  } catch (cause) {
    b.errorCount += 1;
    b.itemCount -= 1;
    serverLogError(
      `Failed to import gateway "${gateway.name}": ${cause}`.replaceAll(
        `\n`,
        " "
      )
    );
  }
}

async function manageNodeImport(
  bi: BulkImport,
  p: PrismaClient,
  project: Prisma.Project,
  node: NodeDEPRECATED
) {
  const b = bi;
  serverLogInfo("node import", node.name, node.nodeId, node.gatewayUID);
  try {
    b.itemCount += 1;
    await p.node.upsert(nodeTransformUpsert(node));
  } catch (cause) {
    b.errorCount += 1;
    b.itemCount -= 1;
    serverLogError(
      `Failed to import node "${node.name}" (${node.nodeId}): ${cause}`.replaceAll(
        `\n`,
        " "
      )
    );
  }
}

/**
 * Implements the DataProvider service using Prisma ORM.
 */
export class PrismaDataProvider implements DataProvider {
  // todo - passing in the project - this is too restraining and belongs in the app layer.
  // but it's like this for now since the original DataProvider interface doesn't have Project.
  // When the domain model refactor is complete, the projectUID constructor parameter can be removed.
  constructor(
    private prisma: PrismaClient,
    private projectUID: ProjectID // todo - remove
  ) {}

  async doBulkImport(
    source?: NotehubAccessor,
    target?: SparrowEventHandler
  ): Promise<BulkImport> {
    serverLogInfo("Bulk import starting");
    const b: BulkImport = { itemCount: 0, errorCount: 0 };

    if (!source)
      throw new Error("PrismaDataProvider needs a source for bulk data import");
    if (!target)
      throw new Error("PrismaDataProvider needs a target for bulk data import");

    const project = await this.currentProject();

    // Some  details have to be fetched from the notehub api (because some
    // gateway details like name are only available in environment variables)
    const notehubProvider = new NotehubDataProvider(source, {
      type: "ProjectID",
      projectUID: project.projectUID,
    });
    const gateways = await notehubProvider.getGateways();
    for (const gateway of gateways) {
      await manageGatewayImport(b, this.prisma, project, gateway);
    }

    const nodes = await notehubProvider.getNodes(gateways.map((g) => g.uid));
    for (const node of nodes) {
      await manageNodeImport(b, this.prisma, project, node);
    }

    const now = new Date(Date.now());
    const pilotBulkImportDays = 10;
    const hoursBack = 24 * pilotBulkImportDays;
    const startDate = new Date(now);
    startDate.setUTCHours(now.getUTCHours() - hoursBack);

    serverLogInfo(`Loading events since ${startDate}`);
    const startDateAsString = `${Math.round(startDate.getTime() / 1000)}`;

    const events = await source.getEvents(startDateAsString);

    const isHistorical = true;
    let i = 0;
    for (const event of events) {
      i += 1;
      try {
        await target.handleEvent(
          sparrowEventFromNotehubEvent(event, project.projectUID),
          isHistorical
        );
        b.itemCount += 1;
      } catch (cause) {
        serverLogError(`Error loading event ${event.uid}. Cause: ${cause}`);
        b.errorCount += 1;
      }
      serverLogProgress("Loaded", events.length, i);
    }

    serverLogInfo("Bulk import complete");

    return b;
  }

  private currentProjectID(): ProjectID {
    return this.projectUID;
  }

  private async currentProject(): Promise<Prisma.Project> {
    // this is intentionally oversimplified - later will need to consider the current logged in user
    // Project should be included in each method so that this interface is agnostic of the fact that the application
    // works with just one project.
    const projectID = this.currentProjectID();
    return this.findProject(projectID);
  }

  private async findProject(projectID: ProjectID): Promise<Prisma.Project> {
    const project = await this.prisma.project.findFirst({
      where: {
        projectUID: projectID.projectUID,
      },
    });
    if (project === null) {
      throw new Error(
        `Cannot find project with projectUID ${projectID.projectUID}`
      );
    }
    return project;
  }

  async getGateways(): Promise<GatewayDEPRECATED[]> {
    const project = await this.currentProject();
    const gateways = await this.prisma.gateway.findMany({
      where: {
        project,
      },
    });

    return gateways.map((gw) => this.sparrowGateway(gw));
  }

  async getGateway(gatewayUID: string): Promise<GatewayDEPRECATED> {
    const project = await this.currentProject();
    const gateway = await this.prisma.gateway.findUnique({
      where: {
        deviceUID: gatewayUID,
      },
    });
    if (gateway === null) {
      throw new Error(
        `Cannot find gateway with DeviceUID ${gatewayUID} in project ${project.projectUID}`
      );
    }
    return this.sparrowGateway(gateway);
  }

  /**
   * Converts a prisma gateway to the old domain model.
   * @param gw
   * @returns
   */
  private sparrowGateway(gw: Prisma.Gateway): GatewayDEPRECATED {
    return {
      uid: gw.deviceUID,
      name: gw.name || "", // todo - we will be reworking the Gateway/Sensor(Node) models. name should be optional
      location: gw.locationName || "",
      lastActivity: gw.lastSeenAt?.toDateString() || "", // todo - ideally this is simply cached
      voltage: 3.5,
      nodeList: [],
    };
  }

  getNodes(gatewayUIDs: string[]): Promise<NodeDEPRECATED[]> {
    // for now just issue multiple queries. Not sure how useful this method is anyway.
    return Promise.all(
      gatewayUIDs.map((gatewayUID) => this.getGatewayNodes(gatewayUID))
    ).then((nodes) => nodes.flat());
  }

  async getGatewayNodes(gatewayUID: string): Promise<NodeDEPRECATED[]> {
    return Promise.resolve([]);
  }

  async getNode(
    gatewayUID: string,
    sensorUID: string
  ): Promise<NodeDEPRECATED> {
    return Promise.reject();
  }

  async getNodeData(
    gatewayUID: string,
    sensorUID: string,
    minutesBeforeNow?: string
  ): Promise<ReadingDEPRECATED<unknown>[]> {
    return Promise.reject();
  }

  private retrieveLatestValues({ projectUID }: { projectUID: string }) {
    const latestReading = {
      // from the readingSource, fetch all sensors and the latest reading of each.
      include: {
        sensors: {
          include: {
            latest: true,
            schema: true,
          },
        },
      },
    };

    // this retrieves the hiearachy of project/gateway/node with the latest reading for each
    return this.prisma.project.findUnique({
      where: {
        projectUID,
      },
      include: {
        gateways: {
          include: {
            readingSource: latestReading,
            nodes: {
              include: {
                readingSource: latestReading,
              },
            },
          },
        },
      },
      rejectOnNotFound: true,
    });
  }

  async queryProjectLatestValues(
    projectID: ProjectID
  ): Promise<QueryResult<ProjectID, ProjectReadingsSnapshot>> {
    let prismaProject;
    try {
      prismaProject = await this.retrieveLatestValues(projectID);
    } catch (cause) {
      throw new ErrorWithCause("Error getting latest values from database.", {
        cause,
      });
    }

    // get the types indirectly so loose coupling
    type P = typeof prismaProject;
    type G = P["gateways"][number];
    type N = G["nodes"][number];
    type RS = G["readingSource"];
    type S = RS["sensors"][number];

    // map the data to the domain model
    const hostReadings = new Map<SensorHost, SensorHostReadingsSnapshot>();

    /**
     * Walks the sensors associated with a ReadingSource, and converts the ReadingSchema and Reading to
     * SensorType and Reading.
     * @param rs
     * @param sensorHost
     */
    const addReadingSource = (rs: RS, sensorHost: SensorHost) => {
      // one reading per sensor type
      const readings = new Map<SensorType, Reading>();

      const snapshot: SensorHostReadingsSnapshot = {
        sensorHost,
        sensorTypes: new Map(),
        readings,
      };

      // maydo - could consider caching the ReadingSchema -> SensorType but it's not that much overhead with duplication per device
      rs.sensors.map((s) => {
        if (s.latest) {
          const sensorType = Mapper.mapReadingSchema(s.schema);
          const reading = Mapper.mapReading(s.latest);

          snapshot.sensorTypes.set(sensorType.name, sensorType);
          readings.set(sensorType, reading);
        }
      });

      hostReadings.set(sensorHost, snapshot);
    };

    const deepMapNode = (n: N) => {
      const result = Mapper.mapNode(n);
      addReadingSource(n.readingSource, result);
      return result;
    };

    const deepMapGateway = (g: G) => {
      // map nodes from Prisma to DomainModel
      const nodes = new Set(g.nodes.map(deepMapNode));
      const result = Mapper.mapGatewayWithNodes(g, nodes);
      // add the reading source to provide the set of SensorType and Readings.
      addReadingSource(g.readingSource, result);
      return result;
    };

    // transform Prisma to DomainModel gateways
    const gateways = new Set(prismaProject.gateways.map(deepMapGateway));
    const project = Mapper.mapProjectHierarchy(prismaProject, gateways);

    const results: ProjectReadingsSnapshot = {
      when: Date.now(),
      project,
      hostReadings: (sensorHost: SensorHost) => {
        const reading = hostReadings.get(sensorHost);
        if (reading == undefined) {
          throw new Error("unknown sensorHost");
        }
        return reading;
      },
      hostReadingByName: (sensorHost: SensorHost, readingName: string) => {
        const snapshot = hostReadings.get(sensorHost);
        const sensorType = snapshot?.sensorTypes.get(readingName);
        return sensorType && snapshot?.readings.get(sensorType);
      },
    };

    return {
      request: projectID,
      results,
    };
  }

  async queryProjectReadingCount(
    projectID: ProjectID
  ): Promise<QueryResult<ProjectID, number>> {
    const count = await this.prisma.reading.count();
    return {
      request: projectID,
      results: count,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  queryProjectReadingSeries(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    query: QueryHistoricalReadings
  ): Promise<QueryResult<QueryHistoricalReadings, ProjectHistoricalData>> {
    throw new Error("Method not implemented.");
  }
}
