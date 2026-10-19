"""给端到端用例提供 macOS/Linux 均可用的超时命令。"""
import signal
import subprocess
import sys

process = subprocess.Popen(sys.argv[2:])
try:
    sys.exit(process.wait(timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    sys.exit(124)
