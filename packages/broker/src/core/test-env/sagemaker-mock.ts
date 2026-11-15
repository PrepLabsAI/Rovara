import { generateServiceMock, serviceMockConfigSchema, type ServiceMockConfig, type ServiceMockOptions } from "./service-contract-mock.js";
import { sageMakerAdapter, type SageMakerContract } from "./sagemaker-contract.js";

// SageMaker's binding of the generic labelled mock config (service-contract-mock.ts): same document, SageMaker's error cases (424, 429, timeout).
export const SageMakerMockConfigSchema = serviceMockConfigSchema(sageMakerAdapter);
export type SageMakerMockConfig = ServiceMockConfig;
export type SageMakerMockOptions = ServiceMockOptions;
export const generateSageMakerMock = (contract: SageMakerContract, options: SageMakerMockOptions = {}): SageMakerMockConfig => generateServiceMock(sageMakerAdapter, contract, options);
