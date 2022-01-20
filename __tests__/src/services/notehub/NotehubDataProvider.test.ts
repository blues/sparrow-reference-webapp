import NotehubDevice from "../../../../src/services/notehub/models/NotehubDevice";
import NotehubDataProvider from "../../../../src/services/notehub/NotehubDataProvider";
import { NotehubApiService } from "../../../../src/services/notehub/NotehubApiService";

describe("Notehub data provider service functions", () => {
  const mockedGatewayJson: NotehubDevice = {
    uid: "dev:5678",
    serial_number: "9101112",
    provisioned: "2021-12-01T11:34:56Z",
    last_activity: "2021-12-14T07:47:29Z",
    contact: "Test User 1",
    product_uid: "net.test:sparrow",
    fleet_uids: [],
    voltage: 3.8,
    temperature: 15,
  };

  let notehubApiServiceMock: NotehubApiService;

  beforeEach(() => {
    notehubApiServiceMock = {
      getGateway: jest.fn().mockResolvedValueOnce(mockedGatewayJson),
    };
  });

  it("should return a single sparrow gateway instance when getGateway is called", async () => {
    const mockGatewayUID = "dev:5678";

    const mockedGatewaySparrowData = {
      lastActivity: "2021-12-14T07:47:29Z",
      serialNumber: "9101112",
      uid: "dev:5678",
      voltage: 3.8,
    };

    const instance = new NotehubDataProvider(notehubApiServiceMock);
    const res = await instance.getGateway(mockGatewayUID);
    expect(res).toEqual(mockedGatewaySparrowData);
  });

  it("should return a list sparrow gateway instances when getGateways is called", async () => {
    const mockedGatewaysSparrowData = [
      {
        lastActivity: "2021-12-14T07:47:29Z",
        serialNumber: "9101112",
        uid: "dev:5678",
        voltage: 3.8,
      },
    ];

    const instance = new NotehubDataProvider(notehubApiServiceMock);
    const res = await instance.getGateways();
    expect(res).toEqual(mockedGatewaysSparrowData);
  });
});
