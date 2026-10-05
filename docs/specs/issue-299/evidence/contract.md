# Contract tests (T3, T8): issue-299

Run on branch `the-loop/issue-299`, Node 22.23.2. Both rows pass: 270 of 270 cases.

## `npx vitest run tests/contract/agent-checks.test.ts --reporter=verbose`

### Summary

```text
 RUN  v5.0.1 <repo>
 Test Files  1 passed (1)
      Tests  270 passed (270)
   Duration  275ms (transform 53%, import 38%, tests 8%, worker 1%)
```

### The #299 cases: `scanTestCommands`, the Requirement 7.3/7.4 checks, and the new `isPipedTestCommand` rows

The abuse cases (T8) are the rows named in the test file's comments: 1 (`pytest; rm -rf build`), 2 (quoted `;` and `&&`),
3 (unquoted backslash), 4 (cd leaving the workspace), 5 (`|| true`, `; true`), 6 (`git stash`), 8 (`tee`, `xargs`,
`sed -i`) and 9 (environment changers). Abuse case 7 is in `unit.md`.

```text
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "cd /testbed; python -m pytest a/test_x.py -q 2>&1 | tail -20" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "cd a;pytest|tail -n 5" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "cd a; cd b; pytest | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "go build && pytest | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest | grep x | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest | tail -5;" as it is 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd /app; QUTE_QT_WRAPPER=PyQt6 python -m pytest tests/unit/misc/test_guiprocess.py -q 2>&1|tail -8" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd /app; QT_QPA_PLATFORM=offscreen python -m pytest tests/unit/browser/webengine -q 2>&1 | tail -4" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd /app && python -m pytest openlibrary/tests/solr -q 2>&1 | tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "python -m pytest openlibrary/tests/solr -q -x 2>&1 | grep -E \"^E\" | head" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "go build ./... && go test ./scanner ./models 2>&1 | tail -20" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "go test ./internal/ext/... 2>&1 | tail -20; go vet ./internal/..." 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd pkg; npm test" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd pkg;npm test 2>&1" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd a&&pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd /app/sub; pytest -q" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest a && pytest b && pytest a" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd a && cd b && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd a/ && cd b; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd /app/x; cd y && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd x && cd /app && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cd pkg && npm install && npm test -- -t foo" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "make build; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest; export X=1" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest;" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "npm test || true" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest | sed -n 1,5p" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest 2>&1 | sort | uniq -c | wc -l" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest | cut -c1-80 | cat" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest -q | egrep 'FAIL|ERROR'" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest | tail -n 5 | head -2" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest -k \"a;b\"" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest -k 'x && y' | tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest; rm -rf build" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "pytest; true" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "cat x | pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds the tests in "npm install" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest a\\;b" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest \\| tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a && cd ../.. && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a; cd /etc; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd /etc; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd ..; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a || exit; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "false || cd a; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd -; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd ~; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd \"a b\"; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a b; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a | cat; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "cd a 2>&1; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "git stash && pytest; git stash pop" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "git -C a stash; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest; git stash" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "git stash list | cat; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | tee out.txt" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | xargs rm" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | sed -i s/x/y/ a.py" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | sed -ni 1p a.py" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | sed --in-place s/x/y/ a.py" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | sed --in-place=.bak s/x/y/ a.py" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest | sh" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "export PYTHONPATH=x; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "PYTHONPATH=x; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "source venv/bin/activate && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses ". venv/bin/activate && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "set -e; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "unset X; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "alias pytest=true; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pushd a && pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "popd; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "shopt -s x; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "ulimit -n 10; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "umask 0; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "eval x; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "exec 3>x; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "declare -x X=1; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "typeset X=1; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "readonly X=1; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "(pytest)" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "{ pytest; }" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest &" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest & pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest |& tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest <<EOF" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest < in.txt" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest > out" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest 2>/dev/null" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest 2>&1 > out" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest 1>&2" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest x2>&1" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest 2>&12" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest\nrm x" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest\r\n" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest\tfoo" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "echo $(pytest)" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "`pytest`" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest $X" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest; echo # x" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "   " 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses ";" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "; pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest;;" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest && ; x" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest &&" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest |" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "| pytest" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > refuses "pytest \"a" 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > marks a command whose parts are only tests, cd and allowed filters as one that changes nothing else 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > maps every cd target, and leaves an unmapped one as written 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > finds each simple command today's matcher replays, with the same replay and its run as a before (Requirement 7.3) 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > keeps every other command today's matcher refuses refused (Requirement 7.4) 0ms
✓ tests/contract/agent-checks.test.ts > scanTestCommands: tests inside chains and filters (#299) > only ever yields a replay that matchTestCommand maps to itself (Requirement 7.1) 1ms
```

### Every pre-existing case (unchanged, still passing)

```text
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "npm test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "npm run test -- -t foo" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pnpm test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "yarn test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest tests/test_a.py -k x" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "python -m pytest -q" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "go test ./..." 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "cargo test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "make test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "mvn test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "gradle test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "./gradlew test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "bundle exec rspec spec/a_spec.rb" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "phpunit" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "tox -e py311" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "cd pkg && npm test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "FOO=1 BAR=2 pytest -k x" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "timeout 600 pytest" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "  pytest  " 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest --junitxml=out/report.xml" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "python -m pytest a/test_x.py -x -q 2>&1 | tail -30" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest -q 2>&1 | tail -n 20" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "cd pkg && npm test 2>&1 | tail -n50" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "go test ./... | tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest|tail -5" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "cargo test 2>&1" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "python3 -m pytest openlibrary/tests/catalog/test_utils.py -k format_lang -v" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "yarn jest --testPathPattern=\"RoomViewStore|RoomView\" --no-coverage 2>&1 | tail -30" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "npx jest src/a.test.ts" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "jest --runInBand" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pnpm jest" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "npx vitest run src" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "vitest run" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "yarn vitest run" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "python -m pytest tests -k \"not slow and (config or qtargs)\"" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest -k 'test_a or test_b'" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest \"-k x\"" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pytest 'x'" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "npx mocha test/template-helpers.js --timeout 10000 2>&1 | tail -20" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "mocha test" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "yarn mocha" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > replays "pnpm mocha test/a.js" 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | tail" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | tail -f" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | head -5" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | grep x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | tail -5 | grep x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest 2>&1 | tail -5 > out.txt" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest > out.txt 2>&1" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest 2>/dev/null | tail -5" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest | tail -5 &" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test; echo x | tail -5" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm install 2>&1 | tail -5" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "echo $(pytest) | tail -5" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test; echo done" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test || true" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test > out.txt" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test &" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "echo $(pytest)" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "`pytest`" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "git stash && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm install" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm run build" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "python setup.py test" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd a && cd b && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest-xdist" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "   " as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest\nrm -rf ." as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest\r\nrm x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest\tfoo" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest\u0000" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd a\n&& pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest\n" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "FOO=$X pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest ${X}" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd $HOME && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest *" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd .. && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd /etc && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd ~ && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd -- && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd a/../.. && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "cd \"a b\" && pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest ~/x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest !x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest a\\b" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest {a,b}" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest [a]" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest ?" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest -k \"$X\"" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest -k \"`id`\"" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest -k \"a\\b\"" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest -k \"a" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "\"pytest\" -k x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest --rootdir=\"/etc\"" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest -k '../x'" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "jest -u" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "yarn jest --updateSnapshot" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npx vitest run -u" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npx vitest --update" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "jest --watch" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "jest --watchAll" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npx mocha --watch" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest --snapshot-update" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "python3 -m pip install x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest --junitxml=/etc/x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "FOO=/etc/x pytest" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "make test -C /" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "pytest --basetemp=../x" as a check 0ms
✓ tests/contract/agent-checks.test.ts > matchTestCommand (FR-003, P-6) > does not treat "npm test --prefix=/tmp" as a check 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > splits "pytest -q 2>&1 | tail -20" 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > splits "pytest -q | tail -n 5" 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > splits "pytest -q 2>&1" 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > splits "pytest -q" 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > splits "pytest | head -5" 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "pytest | tail -5" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "python -m pytest a/test_x.py -q 2>&1 | tail -30" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "cd /testbed && python -m pytest a/test_x.py -q 2>&1 | tail -20" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "cd /testbed; python -m pytest a/test_x.py -q 2>&1 | tail -20" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > runs "cd a;pytest|tail -n 5" with pipefail 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest 2>&1" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest | head -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "echo hi | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "npm install | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest; rm x | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "grep -r x . | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "cd a && cd b && pytest | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "cd a; cd b; pytest | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "go build && pytest | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest | grep x | tail -5" as it is 0ms
✓ tests/contract/agent-checks.test.ts > withoutOutputTail and isPipedTestCommand (pipefail for a piped test command) > leaves "pytest | tail -5;" as it is 0ms
```
