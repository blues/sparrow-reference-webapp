import {
  BulkImport,
  DataProvider,
  QueryHistoricalReadings,
  QueryResult,
} from "../DataProvider";
import NotehubDataProvider from "../notehub/NotehubDataProvider";
import { PrismaDataProvider } from "./PrismaDataProvider";
import Gateway from "../alpha-models/Gateway";
import Node from "../alpha-models/Node";
import ReadingDEPRECATED from "../alpha-models/readings/Reading";
import {
  ProjectHistoricalData,
  ProjectID,
  ProjectReadingsSnapshot,
} from "../DomainModel";
import { NotehubAccessor } from "../notehub/NotehubAccessor";
import { SparrowEventHandler } from "../SparrowEvent";

export default class CompositeDataProvider implements DataProvider {
  constructor(
    private eventHandler: SparrowEventHandler,
    private notehubAccessor: NotehubAccessor,
    private notehubProvider: NotehubDataProvider,
    private prismaDataProvider: PrismaDataProvider
  ) {}

  async doBulkImport(): Promise<BulkImport> {
    const b = await this.prismaDataProvider.doBulkImport(
      this.notehubAccessor,
      this.eventHandler
    );
    return b;
  }

  getGateways(): Promise<Gateway[]> {
    return this.notehubProvider.getGateways();
  }

  getGateway(gatewayUID: string): Promise<Gateway> {
    return this.notehubProvider.getGateway(gatewayUID);
  }

  getNodes(gatewayUIDs: string[]): Promise<Node[]> {
    return this.notehubProvider.getNodes(gatewayUIDs);
  }

  getNode(gatewayUID: string, nodeId: string): Promise<Node> {
    return this.notehubProvider.getNode(gatewayUID, nodeId);
  }

  getNodeData(
    gatewayUID: string,
    nodeId: string,
    minutesBeforeNow?: string | undefined
  ): Promise<ReadingDEPRECATED<unknown>[]> {
    return this.notehubProvider.getNodeData(
      gatewayUID,
      nodeId,
      minutesBeforeNow
    );
  }

  queryProjectLatestValues(
    projectID: ProjectID
  ): Promise<QueryResult<ProjectID, ProjectReadingsSnapshot>> {
    return this.prismaDataProvider.queryProjectLatestValues(projectID);
  }

  queryProjectReadingCount(
    projectID: ProjectID
  ): Promise<QueryResult<ProjectID, number>> {
    return this.prismaDataProvider.queryProjectReadingCount(projectID);
  }

  // eslint-disable-next-line class-methods-use-this
  queryProjectReadingSeries(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    query: QueryHistoricalReadings
  ): Promise<QueryResult<QueryHistoricalReadings, ProjectHistoricalData>> {
    throw new Error("Method not implemented.");
  }
}
