# Running AquaGrow-AI on Windows

The project runs the same way on Windows as on Mac/Linux (it's just
Python + Flask + SQLite), but the exact commands differ a bit. This is
the Windows-specific version of the "How to run it" steps in the main
`README.md`.

## 1. Install Python

Download Python from [python.org/downloads](https://www.python.org/downloads/)
(3.11 or 3.12 recommended - very new Python versions sometimes don't have
pre-built `pandas`/`scikit-learn` packages yet, which makes installing
them slow or fails outright).

During install, **check the box "Add python.exe to PATH"** on the first
setup screen - this is what lets you type `python` from any terminal.

Verify it worked - open **Command Prompt** or **PowerShell** and run:

```powershell
python --version
```

You should see something like `Python 3.12.4`.

## 2. Get the project onto your Windows machine

Copy (or `git clone`, if it's in a repo) the `AquaGrow-AI` folder
onto your Windows computer, then open a terminal (Command Prompt,
PowerShell, or Windows Terminal) and move into it:

```powershell
cd path\to\AquaGrow-AI
```

## 3. Create and activate a virtual environment

```powershell
python -m venv venv
```

Activate it - the command differs by terminal type:

**PowerShell:**
```powershell
venv\Scripts\Activate.ps1
```

If you get an error like *"running scripts is disabled on this
system"*, PowerShell's execution policy is blocking it. Fix it for just
this terminal session with:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```
then try activating again.

**Command Prompt (cmd.exe):**
```cmd
venv\Scripts\activate.bat
```

Either way, you'll know it worked because your prompt now starts with
`(venv)`.

## 4. Install the dependencies

```powershell
pip install -r requirements.txt
```

This installs Flask, pandas, numpy, and scikit-learn. It can take a
couple of minutes the first time.

## 5. Train the AI model (once, or whenever you want to retrain)

```powershell
python ml\train_model.py
```

This prints a test accuracy and classification report, and saves
`ml\model.pkl`. If you skip this step, the app still runs fine - the AI
Prediction card just shows "Not available".

## 6. Run the app

```powershell
python app.py
```

The first time you run it, this creates `database.db` and fills in the
default growth-stage thresholds.

**A "Windows Defender Firewall has blocked some features of this app"
popup may appear** - click **Allow access** (at least for Private
networks). This is what lets other devices on your WiFi - like an ESP32
- actually reach the server; without it, only this computer could load
the dashboard.

## 7. Open the dashboard

```
http://127.0.0.1:5001
```

(Port 5001, not 5000 - the project defaults to 5001 so it works
out-of-the-box across Mac/Windows/Linux regardless of what else might be
using port 5000 on a given machine. If 5001 is somehow already busy on
your PC, change the port number in the last line of `app.py` and reopen
the dashboard at that new port instead.)

From here, everything works exactly as described in the main
`README.md` - the scenario buttons, irrigation control, growth-stage
thresholds, alerts, charts, and AI prediction all behave identically on
Windows.

## Connecting a real ESP32 from Windows

The steps are the same as in `../esp32-irrigation-sensor/README.md`,
with two Windows-specific differences:

- **Finding your PC's local IP address** (to put in the sketch's
  `SERVER_HOST`): open Command Prompt and run
  ```cmd
  ipconfig
  ```
  Look for the "IPv4 Address" under your active WiFi adapter (e.g.
  `192.168.1.42`).
- **Arduino IDE download**: get it from
  [arduino.cc/en/software](https://www.arduino.cc/en/software) (Windows
  installer or Microsoft Store version both work); the rest of the board
  setup, library installation, and upload steps are identical to what's
  described in that README.

## Common Windows issues

- **`python` not found**: Python wasn't added to PATH during install.
  Re-run the Python installer and check "Add python.exe to PATH", or
  use the `py` launcher instead (`py -m venv venv`, `py app.py`, etc.).
- **`pip install` fails building a package**: usually means pip is
  trying to compile something from source because no pre-built package
  exists for your exact Python version. Installing a slightly older,
  more established Python version (3.11 or 3.12) usually fixes this.
- **Port 5001 already in use**: something else on your PC is using it.
  Either close that program, or change the port in the last line of
  `app.py` (and reopen the dashboard at the new port).
- **Dashboard loads but never shows live data**: make sure the terminal
  running `python app.py` is still open - closing it stops the server
  (and the background simulator) entirely.
