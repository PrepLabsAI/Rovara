/** Broker variable names the install rows name that are not in core-engine-infra.ts: kept here so the rows file and broker-environment.ts can both import them (no cycle). */

/** DEC 254z-amend3: the variable the core reads the test services switch from, on a laptop and on AWS alike. */
export const TEST_SERVICES_SETTING_VARIABLE = "ROVARA_TEST_SERVICES";
/** DEC 254zm: the variable the hosted functions read the TestServiceImages setting from (aws/hosted-test-services.ts). */
export const TEST_SERVICE_IMAGES_SETTING_VARIABLE = "ROVARA_TEST_SERVICES_HOSTED_IMAGES";
