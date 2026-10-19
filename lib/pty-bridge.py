#!/usr/bin/env python3
"""Local PTY transport with ownership-scoped descendant cleanup.

Linux uses a subreaper, so detached descendants are adopted by this bridge.
We never signal a process merely because it shares a uid or executable name.
"""
import codecs
import ctypes
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def process_table():
    """pid -> (ppid, pgid, sid, birth identity, state); no process arguments."""
    result = {}
    if sys.platform.startswith('linux'):
        for entry in os.scandir('/proc'):
            if not entry.name.isdigit():
                continue
            try:
                with open(entry.path + '/stat', encoding='utf-8') as stream:
                    raw = stream.read()
                fields = raw[raw.rfind(')') + 2:].split()
                result[int(entry.name)] = (int(fields[1]), int(fields[2]), int(fields[3]), fields[19], fields[0])
            except (OSError, ValueError, IndexError):
                pass
    else:
        listing = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
                                 check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 text=True, timeout=2)
        for line in listing.stdout.splitlines():
            parts = line.split(None, 4)
            if len(parts) != 5:
                continue
            try:
                ident = int(parts[0])
                result[ident] = (int(parts[1]), int(parts[2]), os.getsid(ident), parts[4].strip(), parts[3][0])
            except (OSError, ValueError):
                pass
    return result


if sys.platform.startswith('linux'):
    # PR_SET_CHILD_SUBREAPER: orphaned grandchildren return to this bridge.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Unable to establish terminal child ownership')

config = json.loads(sys.stdin.buffer.readline(65537))
pid, master = pty.fork()
if pid == 0:
    os.chdir(config['cwd'])
    os.execvpe(config['argv'][0], config['argv'], os.environ)

bridge_pid = os.getpid()
owned = {}
root_identity = None
stopping = None
root_exited = False
exit_code = 0


def collect():
    global root_identity
    table = process_table()
    if root_identity is None and pid in table:
        root_identity = table[pid][3]
    current = {ident for ident, birth in owned.items()
               if ident in table and table[ident][3] == birth}
    if pid in table and table[pid][3] == root_identity:
        current.add(pid)
    current.update(ident for ident, info in table.items() if info[2] == pid)
    while True:
        added = {ident for ident, info in table.items()
                 if info[0] == bridge_pid or info[0] in current}
        if added <= current:
            break
        current.update(added)
    current.discard(bridge_pid)
    for ident in current:
        owned[ident] = table[ident][3]
    return {ident: table[ident] for ident in current}


def signal_owned(signum):
    for ident, info in collect().items():
        if info[4] == 'Z':
            continue
        try:
            # Linux identity is kernel starttime, rechecked immediately before signaling.
            if sys.platform.startswith('linux'):
                with open('/proc/%s/stat' % ident, encoding='utf-8') as stream:
                    raw = stream.read()
                if raw[raw.rfind(')') + 2:].split()[19] != info[3]:
                    continue
            os.kill(ident, signum)
        except (OSError, ValueError, IndexError):
            pass


def reap():
    global root_exited, exit_code
    while True:
        try:
            child, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not child:
            break
        if child == pid:
            root_exited = True
            exit_code = os.waitstatus_to_exitcode(status)


def stop(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        signal_owned(signal.SIGTERM)


def emit(value):
    try:
        sys.stdout.write(json.dumps(value, ensure_ascii=True) + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        stop()


def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ,
                struct.pack('HHHH', max(10, min(100, int(rows))), max(40, min(240, int(cols))), 0, 0))


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
resize(config.get('cols', 100), config.get('rows', 28))
os.set_blocking(master, False)
collect()
emit({'type': 'ready', 'pid': pid})
buffer = b''
decoder = codecs.getincrementaldecoder('utf-8')('replace')
stdin_open = True
master_open = True
last_scan = 0
pending_input = b''
try:
    while True:
        reap()
        if root_exited:
            stop()
        current_time = time.monotonic()
        if current_time - last_scan >= 0.2 or stopping is not None:
            collect()
            last_scan = current_time
            if stopping is not None:
                signal_owned(signal.SIGKILL if current_time - stopping >= 0.8 else signal.SIGTERM)
                reap()
                if root_exited and not any(info[4] != 'Z' for info in collect().values()):
                    break
        descriptors = ([master] if master_open else []) + ([0] if stdin_open else [])
        if not descriptors:
            time.sleep(0.05)
            continue
        ready, writable, _ = select.select(descriptors, [master] if pending_input and master_open and stopping is None else [], [], 0.1)
        if master in writable:
            try:
                pending_input = pending_input[os.write(master, pending_input):]
            except BlockingIOError:
                pass
            except OSError:
                pending_input = b''
                stop()
        if master in ready:
            try:
                chunk = os.read(master, 16384)
            except OSError:
                chunk = b''
            if chunk:
                text = decoder.decode(chunk)
                if text:
                    emit({'type': 'output', 'data': text})
            else:
                master_open = False
                stop()
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                stdin_open = False
                stop()
            buffer += chunk
            if len(buffer) > 262144:
                stop()
                buffer = b''
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    message = json.loads(line)
                    if message['type'] == 'input' and stopping is None:
                        pending_input += message['data'].encode('utf-8')
                        if len(pending_input) > 262144:
                            pending_input = b''
                            stop()
                    elif message['type'] == 'resize' and master_open:
                        resize(message['cols'], message['rows'])
                    elif message['type'] == 'stop':
                        stop()
                except (ValueError, KeyError, OSError, TypeError):
                    pass
finally:
    signal_owned(signal.SIGKILL)
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        reap()
        if not any(info[4] != 'Z' for info in collect().values()):
            break
        signal_owned(signal.SIGKILL)
        time.sleep(0.03)
    reap()
    os.close(master)
emit({'type': 'exit', 'code': exit_code})
