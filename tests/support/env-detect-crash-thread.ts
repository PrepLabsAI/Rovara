// A detector thread for the guard's tests that crashes before it sends anything (a stand-in for running out of memory at start-up).
throw new Error("crashed at start-up");
