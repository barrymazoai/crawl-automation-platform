"""One manual invocation: local batch, SSH return, existing-DB import. No service."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    status_file = Path(config['statusFile'])
    log_file = Path(config['logFile'])

    def status(phase, **values):
        temp = status_file.with_suffix('.tmp')
        temp.write_text(json.dumps({'at': time.time(), 'pid': os.getpid(), 'phase': phase, **values}, ensure_ascii=False))
        temp.replace(status_file)

    def remote(which, argv, *, timeout=120):
        result = subprocess.run(config[which] + [shlex.join(argv)], capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f'{which} command failed: {result.stderr[-1000:]}')
        return result.stdout

    batch = config['batchRoot']
    target = config['targetRoot']
    browser = [config['browserNode'], config['browserCli']]
    database = [config['primaryNode'], config['importer']]
    try:
        status('running-browser-batch')
        # Run once. A disconnect/failure stops this controller; it never resubmits
        # the business command. The batch's durable attempts prevent silent retries.
        with log_file.open('a') as log:
            command = config['browserSsh'] + [shlex.join(browser + ['run', batch, str(config['limit'])])]
            result = subprocess.run(command, stdout=log, stderr=log)
        if result.returncode:
            raise RuntimeError('Browser batch stopped abnormally; inspect its exact pages and progress before recovery')
        counts = json.loads(remote('browserSsh', browser + ['status', batch]))
        status('collecting-results', browser=counts)
        package = json.loads(remote('browserSsh', browser + ['package-list', batch], timeout=300))
        remote('primarySsh', ['mkdir', '-m', '700', target])
        source_command = ['tar', '-czf', '-', '-C', batch, '-T', batch + '/transfer-files.txt']
        dest_command = ['tar', '-xzf', '-', '-C', target]
        with log_file.open('a') as log:
            source = subprocess.Popen(config['browserSsh'] + [shlex.join(source_command)], stdout=subprocess.PIPE, stderr=log)
            dest = subprocess.Popen(config['primarySsh'] + [shlex.join(dest_command)], stdin=subprocess.PIPE, stdout=log, stderr=log)
            total = 0
            try:
                while True:
                    chunk = source.stdout.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > config.get('maxTransferBytes', 2 * 1024**3):
                        raise RuntimeError('Transfer size budget reached')
                    dest.stdin.write(chunk)
                dest.stdin.close()
                if source.wait(timeout=30) or dest.wait(timeout=120):
                    raise RuntimeError('Result transfer incomplete')
            except BaseException:
                source.terminate()
                dest.terminate()
                raise
        status('verifying-import', browser=counts, package=package, transferredBytes=total)
        common = [target, config['databaseConfig'], config['identityMap']]
        preview = json.loads(remote('primarySsh', database + ['preview'] + common, timeout=600))
        status('importing-verified-results', browser=counts, previewCount=len(preview['results']), transferredBytes=total)
        imported = json.loads(remote('primarySsh', database + ['apply'] + common, timeout=600))
        summary = {}
        for row in imported['results']:
            key = row.get('state', 'unknown')
            summary[key] = summary.get(key, 0) + 1
        phase = 'completed' if counts['counts']['pending'] == 0 else 'paused-with-results-imported'
        status(phase, browser=counts, imported=summary, transferredBytes=total, targetRoot=target)
    except BaseException as error:
        status('stopped', error=str(error))
        raise


if __name__ == '__main__':
    main()
