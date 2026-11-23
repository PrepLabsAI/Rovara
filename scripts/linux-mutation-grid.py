#!/usr/bin/env python3
"""Manual Linux proof only. Dry-run is read-only and works without Docker on macOS."""
import argparse
import ast
import copy
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

HELPER = 'packages/worker/ec2/close-retention.sh'
BOOT = 'packages/worker/ec2/boot.sh'
TEST = 'tests/linux/worker-close-retention.test.ts'
VALIDATORS = {'require', 'fields', 'text', 'uid', 'positive', 'version', 'generation',
              'selector', 'machine_ids', 'command', 'inspection', 'reply',
              'LayoutManifestV1', 'ControlJournalV1', 'protected', 'data_directory',
              'reject_control_mount_aliases'}


def check_manual():
    if sys.platform != 'linux' or os.environ.get('CODE_CI_LINUX') != '1':
        raise RuntimeError('execution requires Linux and CODE_CI_LINUX=1')


def run(args, cwd, env=None, timeout=600):
    return subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=timeout, check=True).stdout


def python_mutation(source, row, mutation):
    prefix, body = source.split("<<'PY'\n", 1)
    body = body.rsplit('\nPY', 1)[0]
    offset = prefix.count('\n') + 1
    line = row['line'] - offset
    tree = ast.parse(body)
    changed = []

    class Mutate(ast.NodeTransformer):
        def visit_If(self, node):
            if row['kind'] == 'if' and node.lineno == line:
                changed.append(node)
                if mutation == 'remove':
                    return ast.copy_location(ast.Pass(), node)
                node.test = ast.Constant(False) if mutation == 'loosen' else ast.UnaryOp(ast.Not(), node.test)
                return node
            return self.generic_visit(node)

        def visit_Assign(self, node):
            if row['kind'] == 'decision' and node.lineno == line:
                changed.append(node)
                node.value = (ast.UnaryOp(ast.Not(), node.value) if mutation == 'invert' else
                              ast.Name('running', ast.Load()) if mutation == 'loosen' else ast.Constant(False))
                return node
            return self.generic_visit(node)

        def visit_For(self, node):
            if row['kind'] == 'fence-paths' and node.lineno == line:
                changed.append(node)
                node.iter = ast.Tuple([ast.Name('legacy' if mutation == 'invert' else 'JOURNAL', ast.Load())], ast.Load())
                return node
            return self.generic_visit(node)

        def visit_Call(self, node):
            if (row['kind'] == 'call' and node.lineno == line
                    and isinstance(node.func, ast.Name) and node.func.id in VALIDATORS):
                changed.append(node)
                if mutation == 'remove':
                    return ast.copy_location(ast.Constant(None), node)
                if mutation == 'loosen':
                    return ast.copy_location(ast.IfExp(ast.Constant(True), ast.Constant(None), node), node)
                condition = (ast.UnaryOp(ast.Not(), node.args[0]) if node.func.id == 'require'
                             else ast.Compare(node, [ast.IsNot()], [ast.Constant(None)]))
                return ast.copy_location(ast.Call(ast.Name('require', ast.Load()), [condition], []), node)
            return self.generic_visit(node)

    tree = ast.fix_missing_locations(Mutate().visit(copy.deepcopy(tree)))
    if not changed:
        raise RuntimeError(f'no Python guard at {row["line"]}')
    compile(tree, '<linux-mutant>', 'exec')
    return prefix + "<<'PY'\n" + ast.unparse(tree) + '\nPY\n'


def shell_mutation(source, row, mutation):
    old = row['source']
    text = old.strip()
    line = row.get('guard', row['line'])
    if line == 'restore-order':
        replacement = ('Before=$WORKER_UNIT' if mutation == 'remove' else 'Before=$WORKER_UNIT ${SE_UNIT:-rovara-sandbox-egress.service}' if mutation == 'loosen' else text.replace('Before=', 'After=', 1))
    elif line in ('gateway-order', 'services-order'):
        replacement = ('After=docker.service' if mutation == 'remove' else 'After=docker.service $FIREWALL_UNIT' if mutation == 'loosen' else text.replace('After=', 'Before=', 1))
    elif line == 'running-containers':
        replacement = 'if false; then' if mutation != 'invert' else text.replace('-n', '-z')
    elif line in ('list-containers', 'stop-containers', 'repo-digests'):
        command = text.split(' || fail')[0]
        replacement = (('running=""' if line == 'list-containers' else ':') if mutation == 'remove' else
                       command + ' || true' if mutation == 'loosen' else
                       command + ' && { exit 1; }')
    elif line == 'serve-state':
        replacement = ('serve_state=not-found' if mutation == 'remove' else
                       text + ' || serve_state=not-found' if mutation == 'loosen' else text + ' && exit 1')
    elif line == 'serve-reinstall':
        replacement = ('if false; then' if mutation == 'remove' else
                       'if [[ "$serve_state" == active ]]; then' if mutation == 'loosen' else text.replace(' != ', ' == '))
    elif line == 'serve-stop':
        replacement = ':' if mutation == 'remove' else text + (' || true' if mutation == 'loosen' else ' && exit 1')
    elif line == 'rerun-units':
        replacement = ('for unit in; do' if mutation == 'remove' else
                       'for unit in "$WORKER_UNIT" agentx-close-retention.service "$RESTORE_UNIT"; do' if mutation == 'loosen' else
                       text.replace('rovara-sandbox-egress.service', 'missing-gateway.service').replace('rovara-test-services.service', 'missing-services.service'))
    elif row['file'] == BOOT and line in (202, 204, 205):
        condition, body = text[3:].split(': ', 1)
        replacement = ('pass' if mutation == 'remove' else
                       'if False: ' + body if mutation == 'loosen' else
                       'if not (' + condition + '): ' + body)
    elif row['file'] == BOOT and line in (213, 216):
        if mutation == 'invert':
            replacement = text.replace('if ! ', 'if ', 1)
        elif line == 213:
            command = text[len('if ! '):-len('; then')]
            replacement = command + ' || true; if false; then'
            if mutation == 'loosen':
                replacement = text.replace('--network none', '--network bridge')
        else:
            # Keep the heredoc valid; disable the enclosing status refusal only.
            replacement = text.replace('if ! python3', 'if python3')
            source = source.replace('then rm -f "$helper_tmp"; fail "retention helper provenance failed"; fi',
                                    'then :; else :; fi', 1)
            if mutation == 'loosen':
                source = source.replace('then :; else :; fi', 'then :; else log "ignored helper provenance failure"; fi', 1)
    elif text.startswith('[['):
        replacement = (':' if mutation == 'remove' else
                       text.replace('[[', 'true # [[', 1) if mutation == 'loosen' else
                       '! ' + text)
    elif row['file'] == BOOT and line == 207:
        replacement = ':' if mutation != 'invert' else text.replace('if ! ', 'if ', 1)
    elif row['file'] == BOOT and line == 225:
        replacement = (':' if mutation == 'remove' else text.split(' || fail')[0] + ' || true'
                       if mutation == 'loosen' else '! ' + text)
    elif row['file'] == BOOT and line == 463:
        replacement = ':' if mutation == 'remove' else text.replace('0700', '0755' if mutation == 'loosen' else '0000')
    elif row['file'] == BOOT and line == 606:
        replacement = (':' if mutation == 'remove' else text.replace(' || fail "could not quiesce old worker"', ' || true')
                       if mutation == 'loosen' else text.replace('if systemctl', 'if ! systemctl', 1))
    elif row['file'] == HELPER and line == 19:
        replacement = 'if false; then' if mutation != 'invert' else text.replace(' == ', ' != ')
    elif row['file'] == HELPER and line == 28:
        replacement = ('true' if mutation == 'remove' else
                       text.replace('[[ ! -S "$RUN/control.sock" ]] || exit 0', 'exit 0') if mutation == 'loosen' else
                       text.replace('[[ ! -S', '[[ -S'))
    else:
        raise RuntimeError(f'unhandled shell guard {row}')
    if source.count(old) != 1:
        raise RuntimeError(f'ambiguous shell guard {row["file"]}:{line}')
    return source.replace(old, old[:len(old) - len(old.lstrip())] + replacement, 1)


def validate_source(source):
    subprocess.run(['bash', '-n'], input=source, text=True, capture_output=True, check=True)
    for label in ('PY', 'HOST', 'CHECK'):
        match = re.search(r"<<'" + label + r"'\n([\s\S]*?)\n" + label + r"(?:\n|$)", source)
        if match:
            compile(match[1], '<embedded-' + label + '>', 'exec')


def plan(repository):
    guards = json.loads((repository / 'scripts/linux-mutation-grid.json').read_text())
    if len(guards) != 55 or sum(row['kind'] != 'shell' for row in guards) != 29:
        raise RuntimeError('expected 29 Python guards (87 cells) plus 26 shell guards (78 cells)')
    if any(not row.get('expectedFailure') for row in guards):
        raise RuntimeError('every guard needs a targeted expected failure')
    rows = []
    for guard in guards:
        source = (repository / guard['file']).read_text()
        if source.splitlines()[guard['line'] - 1] != guard['source']:
            raise RuntimeError(f'stale guard coordinate: {guard["file"]}:{guard["line"]}')
        for mutation in ('remove', 'loosen', 'invert'):
            mutated = (shell_mutation if guard['kind'] == 'shell' else python_mutation)(source, guard, mutation)
            if mutated == source:
                raise RuntimeError('unchanged mutant')
            validate_source(mutated)
            rows.append({**guard, 'mutation': mutation, 'equivalence': guard.get('equivalences', {}).get(mutation), 'test': TEST + ' -t ' + guard['test'],
                         'replacementSha256': hashlib.sha256(mutated.encode()).hexdigest(),
                         'diff': ''.join(difflib.unified_diff(source.splitlines(True), mutated.splitlines(True), n=1))})
    return rows


class Images:
    """One loopback registry store; removed before each disposable-host test."""
    def __init__(self, repository, temporary):
        self.repository = repository
        self.storage = temporary / 'registry'
        self.storage.mkdir()
        self.port = None

    def digest(self, tag):
        registry = 'registry:2'
        container = run(['docker', 'run', '-d', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
                         '-p', f'127.0.0.1:{self.port or ""}:5000',
                         '-v', str(self.storage) + ':/var/lib/registry', registry], self.repository).strip()
        try:
            binding = run(['docker', 'port', container, '5000/tcp'], self.repository).strip()
            self.port = binding.rsplit(':', 1)[1]
            reference = f'localhost:{self.port}/close-retention:proof'
            run(['docker', 'tag', tag, reference], self.repository)
            for attempt in range(20):
                try:
                    run(['docker', 'push', reference], self.repository)
                    break
                except subprocess.CalledProcessError:
                    if attempt == 19:
                        raise
                    time.sleep(0.2)
            info = json.loads(run(['docker', 'image', 'inspect', reference], self.repository))[0]
            digest = next(ref for ref in info['RepoDigests'] if ref.startswith(reference.split(':proof')[0] + '@sha256:'))
            run(['docker', 'pull', digest], self.repository)
            return digest
        finally:
            run(['docker', 'rm', '--force', container], self.repository)


def result(repository, image, selector, report, expected_failure=None):
    env = {**os.environ, 'CODE_CI_LINUX': '1', 'CLOSE_RETENTION_TEST_IMAGE': image}
    args = [str(repository / 'node_modules/.bin/vitest'), 'run', TEST, '--bail=1',
            '--no-file-parallelism', '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(report)]
    if selector:
        args += ['-t', selector]
    try:
        output = run(args, repository, env, timeout=540)
        code = 0
    except subprocess.CalledProcessError as error:
        code, output = error.returncode, error.stdout
    # A crash, timeout, zero tests or skipped target is not evidence of a killed guard.
    data = json.loads(report.read_text())
    assertions = [case for suite in data.get('testResults', []) for case in suite.get('assertionResults', [])
                  if not selector or selector in case['fullName']]
    valid = len(assertions) == (1 if selector else 2) and all(case['status'] in ('passed', 'failed') for case in assertions)
    killed = valid and code != 0 and any(case['status'] == 'failed' for case in assertions)
    failures = '\n'.join(message for case in assertions for message in case.get('failureMessages', []))
    targeted = re.search(expected_failure, failures, re.MULTILINE) if expected_failure else None
    if expected_failure:
        killed = killed and targeted is not None
    excerpt = (('TARGETED FAILURE: ' + targeted.group(0) + '\n') if targeted else '') + (failures[-12000:] if failures else output[-3000:])
    return code == 0 and valid and all(case['status'] == 'passed' for case in assertions), killed, excerpt


def execute(repository, output):
    check_manual()
    image = os.environ.get('CLOSE_RETENTION_TEST_IMAGE', '')
    if not re.fullmatch(r'localhost:[0-9]+/close-retention@sha256:[0-9a-f]{64}', image):
        raise RuntimeError('CLOSE_RETENTION_TEST_IMAGE must be the prepared loopback digest')
    rows = plan(repository)
    document = {'baselineBefore': False, 'baselineAfter': False, 'mutants': []}
    def save():
        output.write_text(json.dumps(document, indent=2) + '\n')
    save()
    with tempfile.TemporaryDirectory(prefix='close-retention-linux-grid-') as temporary:
        temporary = Path(temporary)
        scratch = temporary / 'repo'
        shutil.copytree(repository, scratch, ignore=shutil.ignore_patterns('.git', 'node_modules', 'dist', '*.tsbuildinfo', 'linux-mutants.json'))
        (scratch / 'node_modules').symlink_to(repository / 'node_modules', target_is_directory=True)
        for built in (repository / 'packages').glob('*/dist'):
            (scratch / built.relative_to(repository)).symlink_to(built, target_is_directory=True)
        images = Images(scratch, temporary)
        originals = {path: (scratch / path).read_text() for path in {row['file'] for row in rows} | {HELPER, BOOT}}
        try:
            document['baselineBefore'], _, excerpt = result(scratch, image, '', temporary / 'baseline-before.json')
            document['baselineBeforeLog'] = excerpt
            save()
            if not document['baselineBefore']:
                raise RuntimeError('baseline before mutations is red or skipped')
            for index, row in enumerate(sorted(rows, key=lambda r: (r['test'], r['file'], r['line'], r['mutation']))):
                if row.get('equivalence'):
                    document['mutants'].append({**row, 'killed': False, 'equivalent': True, 'logExcerpt': 'Not executed: ' + row['equivalence']})
                    save()
                    continue
                target = scratch / row['file']
                mutated = (shell_mutation if row['kind'] == 'shell' else python_mutation)(originals[row['file']], row, row['mutation'])
                target.write_text(mutated)
                try:
                    mutant_image = image
                    if row['file'] == HELPER:
                        digest = hashlib.sha256(mutated.encode()).hexdigest()
                        (scratch / BOOT).write_text(re.sub(r'readonly CLOSE_HELPER_SHA256=[0-9a-f]{64}', 'readonly CLOSE_HELPER_SHA256=' + digest, originals[BOOT]))
                        (scratch / 'close-retention-mutant.Dockerfile').write_text('FROM rovara-close-retention-base:ci\nCOPY packages/worker/ec2/close-retention.sh /opt/agentx/packages/worker/ec2/close-retention.sh\n')
                        run(['docker', 'build', '--pull=false', '-f', 'close-retention-mutant.Dockerfile', '-t', 'rovara-close-retention-mutant:ci', '.'], scratch)
                        mutant_image = images.digest('rovara-close-retention-mutant:ci')
                    _, killed, excerpt = result(scratch, mutant_image, row['test'].split(' -t ')[1], temporary / f'mutant-{index}.json', row['expectedFailure'])
                    document['mutants'].append({**row, 'killed': killed, 'logExcerpt': excerpt})
                    print(f'{index+1}/{len(rows)} {row["file"]}:{row["line"]} {row["mutation"]} killed={killed}', flush=True)
                    save()
                finally:
                    for path, source in originals.items():
                        (scratch / path).write_text(source)
        finally:
            for path, source in originals.items():
                (scratch / path).write_text(source)
            document['baselineAfter'], _, excerpt = result(scratch, image, '', temporary / 'baseline-after.json')
            document['baselineAfterLog'] = excerpt
            save()
    verify_document(document, len(rows))


def verify_document(document, expected):
    if (not document['baselineBefore'] or not document['baselineAfter']
            or len(document['mutants']) != expected or any(not row['killed'] and not (row.get('equivalent') is True and row.get('equivalence')) for row in document['mutants'])):
        raise RuntimeError('Linux mutation proof incomplete: baseline red, missing result or surviving mutant')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--prepare-image', action='store_true')
    parser.add_argument('--output', type=Path, default=Path('linux-mutants.json'))
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    if args.dry_run:
        print(json.dumps(plan(repository), indent=2))
    elif args.prepare_image:
        check_manual()
        run(['docker', 'build', '-f', 'environments/base/Dockerfile', '-t', 'rovara-close-retention-base:ci', '.'], repository, timeout=1800)
        with tempfile.TemporaryDirectory(prefix='close-retention-registry-') as temporary:
            image = Images(repository, Path(temporary)).digest('rovara-close-retention-base:ci')
        with open(os.environ['GITHUB_ENV'], 'a') as environment:
            environment.write('CLOSE_RETENTION_TEST_IMAGE=' + image + '\n')
    else:
        execute(repository, args.output.resolve())


if __name__ == '__main__':
    main()
