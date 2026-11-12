// The fakes the conformance suites run on, in one place. They live with the core (`@agentx/broker/fakes` for the code host, tracker and check runner, `@agentx/broker/ports` for the rest);
// a provider's tests import them from here, so they need to know no path inside the core. The fakes' webhook secrets are public constants: never register one in a production build.
export * from "@agentx/broker/fakes";
export {
  FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter, FakeWorkerMachines, MemoryDocumentStore, MemoryQueueService,
  createFakeEmailSender, createFakeImageRegistry, createFakeMonitoringAdapter, createFakeRecordSource, createFakeScheduler,
  createInProcessRealtime, createMemoryLessonVectors, createMemoryLearningAdapter, createMemoryModelKeyStore, createMemoryRecordSink,
} from "@agentx/broker/ports";
