# FreeJoy - Universal Wireless Gamepad

## In plain English

FreeJoy turns phones and tablets into game controllers for a Windows PC, so a group can play together without owning a separate physical gamepad for every person. One computer hosts the room; players scan a QR code and their touch controls are translated into virtual Xbox 360 controllers.

**Example:** during a four-player game night, the host opens FreeJoy on the PC and friends join with their phones. Each person receives a player slot, can reconnect after the phone sleeps, and controls the emulator through the same familiar layout.

| Feature | What it means for players |
| --- | --- |
| QR-code connection | Joining does not require installing or pairing a separate mobile app. |
| Automatic player slots | Up to eight people (configurable to 16) can join without manually configuring every controller. |
| Game-specific phone controllers | The host can switch every phone to a simpler layout (Party, Racing, Retro…), and games can push their own controls, AirConsole style. |
| Virtual Xbox 360 devices | Compatible Windows games and emulators see ordinary controller inputs. |
| Session reconnection | Refreshing the browser or waking a phone does not immediately lose the assigned player. |
| Host controls | The person running the game can see, remove, or reset connected players from one screen. |

> **Maturity and limits:** FreeJoy is a working Windows/Ryujinx prototype. It
> depends on a local network and Python's `vgamepad`; latency has not been
> independently benchmarked, and broader emulator support is not claimed.

## Technical summary

FreeJoy is a full-stack controller solution that turns any mobile device into a networked gamepad for PC emulators. It features a Node.js/Socket.IO backend using `vgamepad` for virtual Xbox 360 controller emulation and a React frontend with a Pro Controller UI.

## ⚡ Main Features

*   **Zero-Config Connection**: Scan a single QR code to connect instantly - player slots are auto-assigned.
    
    ![QR Screen](docs/qr_screen.png)

*   **Pro Controller Layout**: All players use the same full-featured Pro Controller UI with dual analog sticks, split Joy-Con style layout (cyan left, red right), LED player indicators, and neon-glowing controls.
    
    ![Pro UI](docs/pro_ui.png)

*   **Virtual Gamepad Emulation**: Creates true Xbox 360 virtual controllers via Python's `vgamepad` library.
*   **Player Management**: 
    *   Real-time connected players list on host screen
    *   Custom device nicknames (e.g. "iPhone di Antonio")
    *   Kick individual players (online or offline)
    *   Reset room to clear all controller leases
*   **Persistent Sessions**: Auto-reconnect logic restores player slots if the browser refreshes or device sleeps.
*   **Auto-Assignment**: Players are automatically assigned slots 1-8 in order of connection. Players 1-4 get virtual Xbox 360 controllers; players 5+ get virtual DualShock 4 controllers, because Windows XInput only exposes four Xbox pads. Set `FREEJOY_MAX_PLAYERS` (1-16) to change the limit and `FREEJOY_CONTROLLER_TYPE=xbox|ds4|auto` to force a controller type.
*   **Phone Controller Layouts (AirConsole style)**: From the host screen, switch all phones to a layout that fits the game, e.g. *Party* (big stick + A/B) for Pummel Party. Every layout still drives the virtual gamepad. Games you write can push their own layouts and receive touches directly; see the *Game socket* section of [API_CONTRACT.md](API_CONTRACT.md), the SDK in `client/public/freejoy-game.js`, and the example game linked from the host screen.
*   **Smooth Under Load**: Stick movement is merged on the server (newest value wins) so fast thumbs never trip the input limit or disconnect a controller, and phones keep retrying the connection instead of giving up.
*   **Kick Protection**: A kick revokes that controller lease and rotates the QR capability without interrupting other players.
*   **Premium UI**: 
    *   Animated splash screen during connection
    *   Visual LED player indicator (P1-P4)
    *   Neon glow effects on all buttons
    *   Glossy 3D button styling
    *   Haptic feedback on button press
*   **Smart Layouts**: 
    *   **Landscape Lock**: Enforces landscape orientation for maximum playability.
    *   **Safe Area Handling**: Optimized for notched phones and tablets.

## 🎮 Supported Emulators

*   **Ryujinx** (Nintendo Switch) - Primary target

## 🚀 Quick Start

### Prerequisites

*   **Node.js** 20.19+ (20.x) or 22.12+ and npm
*   **Python** 3.8+ with `vgamepad` library
*   **Windows** (required for `vgamepad` Xbox 360 controller emulation)

### Installation

1.  **Clone the repository**:
    
    ```bash
    git clone https://github.com/aantenore/FreeJoy.git
    cd FreeJoy
    ```
    
2.  **Install Node.js dependencies**:
    
    ```bash
    # Server
    cd server
    npm ci
    
    # Client
    cd ../client
    npm ci
    ```
    
3.  **Install Python dependencies**:
    
    ```bash
    cd ../server/src/python
    pip install vgamepad
    ```

### Running the Application

**Option 1: PowerShell Launcher (Recommended)**

```powershell
./Launcher.ps1
```

This script:
- Builds the client (production-optimized Vite bundle)
- Starts the Node.js server
- Generates separate host/controller capabilities and opens the authorized host page

**Option 2: Manual Start**

```bash
# Configure distinct capabilities before starting the server.
export FREEJOY_HOST_TOKEN=<at-least-16-base64url-characters>
export FREEJOY_JOIN_TOKEN=<different-at-least-16-base64url-characters>

cd server
npm run dev

# Open http://localhost:3000/#host=<FREEJOY_HOST_TOKEN>.
# Capability URLs are intentionally omitted from process logs.
```

On PowerShell, set the same values with `$env:FREEJOY_HOST_TOKEN = "..."` and
`$env:FREEJOY_JOIN_TOKEN = "..."`. The launcher creates these values for you.

### Connecting Controllers

1.  **Host Screen**: Use the launcher or your configured host capability to open the QR screen
2.  **Mobile Devices**: Scan the QR code with your phone/tablet camera
3.  **Auto-Assignment**: Players are automatically assigned slots P1-P8 (set `FREEJOY_MAX_PLAYERS` for up to 16)
4.  **Start Playing**: The virtual Xbox 360 controller is ready in Ryujinx!

## 📱 Player Management

**Host Features:**
- View all connected players with real-time status
- See custom device nicknames
- Kick any player (connected or disconnected)
- Reset entire room to start fresh

**Player Features:**
- Custom nickname on first connection (saved in browser)
- Automatic reconnection on refresh/sleep
- Clear feedback when kicked

## 🎯 Button Mapping

The Pro Controller layout maps to Xbox 360 as follows:

| **Switch** | **Xbox 360** |
|-----------|-------------|
| A | B |
| B | A |
| X | Y |
| Y | X |
| L / ZL | LB / LT |
| R / ZR | RB / RT |
| D-Pad | D-Pad |
| Left Stick | Left Stick |
| Right Stick | Right Stick |
| - (Minus) | Back |
| + (Plus) | Start |

## 🏗️ Architecture

### Stack
*   **Backend**: Node.js + Express + Socket.IO + TypeScript
*   **Frontend**: React (Vite) + Socket.IO Client
*   **Gamepad**: Python `vgamepad` (Xbox 360 emulation)

### How It Works

1.  **Connection**: Client scans QR → WebSocket connection established
2.  **Assignment**: Server auto-assigns slot (1-8 by default) based on availability
3.  **Input Flow**: 
    - Browser captures touch events
    - Socket.IO sends to server
    - Node.js forwards to Python via stdin
    - Python controls virtual Xbox 360 gamepad
4.  **Reconnection**: An opaque server-issued capability in localStorage restores the controller lease

### Key Design Decisions

*   **Single Python Process**: One process manages all 4 virtual controllers efficiently
*   **Ephemeral Room IDs**: Short alphanumeric codes for easy sharing
*   **Separate Capabilities**: Host administration and controller joining use independently configurable tokens
*   **Fail-Safe Lifecycle**: Disconnect, kick, reset, timeout, and shutdown neutralize each active virtual controller once
*   **Stateless Sessions**: No database - all state in memory for minimal latency
*   **Device Nicknames**: Stored in browser localStorage for personalization
*   **Controller Lease**: A server-directed heartbeat and retry window preserve safe reconnection without allowing socket takeover
*   **Kick Semantics**: Revokes the player lease and rotates the QR capability while preserving other active players
*   **Log Hygiene**: Host, QR, and reconnect capabilities are never written to process logs

## 🔧 Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and Socket.IO port |
| `PUBLIC_HOST` | detected LAN address | Address placed in the controller QR URL |
| `FREEJOY_HOST_TOKEN` | random at startup | Host API and administration capability; minimum 16 base64url characters |
| `FREEJOY_JOIN_TOKEN` | random at startup | Controller join capability; minimum 16 base64url characters |
| `FREEJOY_INPUT_EVENTS_PER_SECOND` | `120` | Per-controller input ceiling, from 10 to 1000; the current window survives reconnects, and overflow safely releases without creating a host ban |
| `FREEJOY_CONTROLLER_LEASE_MS` | `30000` | Live and disconnected controller lease window, from 5 seconds to 5 minutes |
| `FREEJOY_CLEANUP_INTERVAL_MS` | up to `2000` | Lease cleanup cadence, from 250 ms up to the configured lease |

Capabilities are carried in URL fragments, so browsers do not send them in the initial HTTP request. Host and join values must differ. Kicking a controller rotates the in-memory join capability and refreshes the host QR code. A restart rotates generated capabilities and invalidates previous controller leases.

### Python Path

Edit `server/src/plugins/RyujinxPlugin.ts` if Python is not in PATH:

```typescript
this.pythonProcess = spawn('python', [...], {
    // Add custom python path if needed
});
```

## 🐛 Troubleshooting

### Controllers Not Detected in Ryujinx

1.  Check Windows Device Manager for "Xbox 360 Controller for Windows"
2.  Ensure `vgamepad` is installed: `pip show vgamepad`
3.  Restart Ryujinx after connecting controllers
4.  Check server console for Python errors

### Connection Issues

*   **QR Code Not Scanning**: Ensure phone and PC are on same network
*   **"Room Full" Error**: Default maximum is 8 players - raise `FREEJOY_MAX_PLAYERS`, kick an offline player, or use Reset Room
*   **Kicked Player Rejoining**: Use the refreshed host QR; the previous player and QR capabilities are revoked
*   **Reconnection Fails**: Clear browser data and scan QR again

### Input Lag

*   Use 5GHz WiFi for best performance
*   Close background apps on mobile device
*   Reduce distance between device and router

## 📝 Development

### Project Structure

```
FreeJoy/
├── client/                 # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ProController.tsx    # Main controller UI
│   │   │   └── InstallBanner.jsx    # PWA install prompt
│   │   ├── App.jsx                  # Host + routing logic
│   │   └── main.jsx
│   └── package.json
├── server/                 # Node.js backend
│   ├── src/
│   │   ├── plugins/
│   │   │   ├── IPlugin.ts           # Plugin interface
│   │   │   └── RyujinxPlugin.ts     # vgamepad integration
│   │   ├── python/
│   │   │   └── virtual_gamepad.py   # Xbox controller emulation
│   │   ├── server.ts                # Express + Socket.IO server
│   │   ├── authority.ts             # Host/controller capabilities
│   │   ├── protocol.ts              # Validated controller protocol
│   │   ├── roomManager.ts           # Player/room state
│   │   ├── wsHandler.ts             # WebSocket events
│   │   └── types.ts                 # TypeScript types
│   └── package.json
├── docs/                   # Screenshots
├── Launcher.ps1            # PowerShell launcher script
└── README.md
```

### Adding New Emulator Support

1.  Create plugin in `server/src/plugins/YourEmulator.ts`
2.  Implement `IPlugin` interface
3.  Wire it in `server/src/server.ts`

## 🎨 UI Customization

### Button Styling

Edit `client/src/components/ProController.tsx` - all buttons use inline styles with CSS-in-JS for neon effects.

### Color Scheme

Primary colors:
- Left Joy-Con: `#00C3E3` (Cyan)
- Right Joy-Con: `#FF4D6D` (Red)
- ABXY: Individual neon colors (Green/Red/Yellow/Cyan)

## 📄 License

MIT License - See LICENSE file

## 🙏 Acknowledgments

*   [vgamepad](https://github.com/yannbouteiller/vgamepad) - Xbox controller emulation
*   [Socket.IO](https://socket.io/) - Real-time communication
*   [React Joystick Component](https://github.com/elmarti/react-joystick-component) - Analog stick UI

---

**Note**: This project requires Windows for `vgamepad` Xbox 360 controller emulation. Linux/Mac support would require alternative virtual gamepad solutions., from the draggable analog sticks to the seamless mobile experience, every line of code was a collaborative dance between human creativity and AI precision.

> *"Any sufficiently advanced AI is indistinguishable from a very caffeinated developer at 3 AM."*  
> — Arthur C. Clarke (probably)

Special thanks to Antigravity for:
- 🎨 Making the Controller aesthetics actually look premium
- 🐛 Debugging PowerShell scripts that shall not be named
- 🎮 Remembering that D-Pads go on the LEFT side of controllers
- 📱 Teaching me that Wi-Fi interfaces have many names (wlan, wl, wi-fi, wireless...)
- ✨ And for never judging my "just one more feature" requests

*P.S. - If this README seems suspiciously well-organized, that's because an AI wrote it. If you find bugs, that's all me.* 😄

---

## 👨‍💻 Author

**Antonio Antenore**  
Computer Engineer
