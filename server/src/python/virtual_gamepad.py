#!/usr/bin/env python3
"""
Virtual Gamepad Controller for Ryujinx
Uses vgamepad to create virtual Xbox 360 (players 1-4) and DualShock 4
(players 5+) controllers on Windows.
Controlled via stdin JSON messages from Node.js server.
"""

import os
import sys
import json
import vgamepad as vg
from typing import Dict, Set, Union

# Global controller pool (player_id -> VX360Gamepad or VDS4Gamepad instance)
controllers: Dict[int, Union[vg.VX360Gamepad, vg.VDS4Gamepad]] = {}
# Held D-pad directions per DS4 player (DS4 reports the D-pad as one hat value)
ds4_dpad: Dict[int, Set[str]] = {}
# Controller type each player picked on their phone ('xbox' or 'ds4')
player_types: Dict[int, str] = {}

# Players choose Xbox or PlayStation on their phone and the server sends it with
# 'init'. Without a choice, Windows XInput's four-Xbox-pad limit decides: players
# 5+ get DualShock 4 pads. FREEJOY_CONTROLLER_TYPE=xbox|ds4 forces one type.
CONTROLLER_TYPE = os.environ.get("FREEJOY_CONTROLLER_TYPE", "auto").strip().lower()
XINPUT_LIMIT = 4

# Button mapping: Switch Pro Controller -> Xbox 360
BUTTON_MAP = {
    'A': vg.XUSB_BUTTON.XUSB_GAMEPAD_B,           # Switch A = Xbox B (position)
    'B': vg.XUSB_BUTTON.XUSB_GAMEPAD_A,           # Switch B = Xbox A (position)
    'X': vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,           # Switch X = Xbox Y (position)
    'Y': vg.XUSB_BUTTON.XUSB_GAMEPAD_X,           # Switch Y = Xbox X (position)
    'L': vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    'R': vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    'ZL': 'LEFT_TRIGGER',                          # Analog trigger
    'ZR': 'RIGHT_TRIGGER',                         # Analog trigger
    'Plus': vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    'Minus': vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
    'L3': vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
    'R3': vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
    'DPadUp': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    'DPadDown': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    'DPadLeft': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    'DPadRight': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
    'SL': vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,       # Map SL to Guide button
    'SR': vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,       # Map SR to Guide button
}

# Button mapping: Switch Pro Controller -> DualShock 4 (same physical positions)
DS4_BUTTON_MAP = {
    'A': vg.DS4_BUTTONS.DS4_BUTTON_CIRCLE,
    'B': vg.DS4_BUTTONS.DS4_BUTTON_CROSS,
    'X': vg.DS4_BUTTONS.DS4_BUTTON_TRIANGLE,
    'Y': vg.DS4_BUTTONS.DS4_BUTTON_SQUARE,
    'L': vg.DS4_BUTTONS.DS4_BUTTON_SHOULDER_LEFT,
    'R': vg.DS4_BUTTONS.DS4_BUTTON_SHOULDER_RIGHT,
    'ZL': 'LEFT_TRIGGER',
    'ZR': 'RIGHT_TRIGGER',
    'Plus': vg.DS4_BUTTONS.DS4_BUTTON_OPTIONS,
    'Minus': vg.DS4_BUTTONS.DS4_BUTTON_SHARE,
    'L3': vg.DS4_BUTTONS.DS4_BUTTON_THUMB_LEFT,
    'R3': vg.DS4_BUTTONS.DS4_BUTTON_THUMB_RIGHT,
    'DPadUp': 'up',
    'DPadDown': 'down',
    'DPadLeft': 'left',
    'DPadRight': 'right',
    'SL': 'PS',
    'SR': 'PS',
}

DS4_HAT = {
    (False, False, False, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_NONE,
    (True, False, False, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_NORTH,
    (False, True, False, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_SOUTH,
    (False, False, True, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_WEST,
    (False, False, False, True): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_EAST,
    (True, False, True, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_NORTHWEST,
    (True, False, False, True): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_NORTHEAST,
    (False, True, True, False): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_SOUTHWEST,
    (False, True, False, True): vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_SOUTHEAST,
}


def uses_ds4(player_id: int) -> bool:
    if player_id in player_types:
        return player_types[player_id] == "ds4"
    if CONTROLLER_TYPE == "ds4":
        return True
    if CONTROLLER_TYPE == "xbox":
        return False
    return player_id > XINPUT_LIMIT


def get_or_create_controller(player_id: int) -> Union[vg.VX360Gamepad, vg.VDS4Gamepad]:
    """Get existing controller or create new one for player."""
    if player_id not in controllers:
        if uses_ds4(player_id):
            controllers[player_id] = vg.VDS4Gamepad()
            ds4_dpad[player_id] = set()
            log(f"Created virtual DualShock 4 for Player {player_id}")
        else:
            controllers[player_id] = vg.VX360Gamepad()
            log(f"Created virtual Xbox 360 gamepad for Player {player_id}")
    return controllers[player_id]


def handle_button(player_id: int, button: str, pressed: bool):
    """Handle button press/release."""
    gamepad = get_or_create_controller(player_id)
    is_ds4 = isinstance(gamepad, vg.VDS4Gamepad)
    button_map = DS4_BUTTON_MAP if is_ds4 else BUTTON_MAP

    if button not in button_map:
        log(f"Unknown button: {button}")
        return

    mapping = button_map[button]

    # Handle triggers separately (analog 0-255)
    if mapping == 'LEFT_TRIGGER':
        gamepad.left_trigger(255 if pressed else 0)
        if is_ds4:
            (gamepad.press_button if pressed else gamepad.release_button)(vg.DS4_BUTTONS.DS4_BUTTON_TRIGGER_LEFT)
    elif mapping == 'RIGHT_TRIGGER':
        gamepad.right_trigger(255 if pressed else 0)
        if is_ds4:
            (gamepad.press_button if pressed else gamepad.release_button)(vg.DS4_BUTTONS.DS4_BUTTON_TRIGGER_RIGHT)
    elif is_ds4 and mapping == 'PS':
        special = vg.DS4_SPECIAL_BUTTONS.DS4_SPECIAL_BUTTON_PS
        (gamepad.press_special_button if pressed else gamepad.release_special_button)(special)
    elif is_ds4 and mapping in ('up', 'down', 'left', 'right'):
        held = ds4_dpad.setdefault(player_id, set())
        if pressed:
            held.add(mapping)
        else:
            held.discard(mapping)
        up, down = 'up' in held, 'down' in held
        left, right = 'left' in held, 'right' in held
        # Opposite directions cancel out, like a physical D-pad.
        if up and down:
            up = down = False
        if left and right:
            left = right = False
        gamepad.directional_pad(direction=DS4_HAT[(up, down, left, right)])
    else:
        # Digital button
        if pressed:
            gamepad.press_button(mapping)
        else:
            gamepad.release_button(mapping)

    gamepad.update()
    if os.environ.get("FREEJOY_DEBUG_INPUT") == "1": log(f"P{player_id} {button} {'pressed' if pressed else 'released'}")


def handle_analog(player_id: int, stick: str, x: float, y: float):
    """Handle analog stick input."""
    gamepad = get_or_create_controller(player_id)

    # Keep the native driver boundary safe even if a future caller bypasses the
    # TypeScript protocol validator.
    x = max(-1.0, min(1.0, float(x)))
    y = max(-1.0, min(1.0, float(y)))

    if isinstance(gamepad, vg.VDS4Gamepad):
        # DS4 axes are 0-255 with 128 centered and 0 = up (same as screen y).
        x_int = max(0, min(255, round(128 + x * 127)))
        y_int = max(0, min(255, round(128 + y * 127)))
    else:
        # Convert from -1.0 to 1.0 range to -32768 to 32767 range
        x_int = int(x * 32767)
        y_int = int(-y * 32767)  # Invert Y axis (up is positive in vgamepad)

    if stick == 'left':
        gamepad.left_joystick(x_value=x_int, y_value=y_int)
    elif stick == 'right':
        gamepad.right_joystick(x_value=x_int, y_value=y_int)

    gamepad.update()
    if os.environ.get("FREEJOY_DEBUG_INPUT") == "1": log(f"P{player_id} {stick}_stick X:{x:.2f} Y:{y:.2f}")


def handle_disconnect(player_id: int):
    """Remove controller for disconnected player."""
    if player_id in controllers:
        # Reset controller to neutral state before removing
        gamepad = controllers[player_id]
        gamepad.reset()
        gamepad.update()
        del controllers[player_id]
        ds4_dpad.pop(player_id, None)
        log(f"Removed virtual gamepad for Player {player_id}")


def log(message: str):
    """Log to stderr (stdout is used for IPC)."""
    print(f"[VGamepad] {message}", file=sys.stderr, flush=True)


def main():
    """Main loop - read JSON commands from stdin."""
    log("Virtual Gamepad Service Started")
    log("Waiting for commands...")
    
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            
            try:
                cmd = json.loads(line)
                action = cmd.get('action')
                player_id = cmd.get('playerId')
                
                if not player_id:
                    log(f"Missing playerId in command: {cmd}")
                    continue
                
                if action == 'button':
                    button = cmd.get('button')
                    pressed = cmd.get('pressed', False)
                    handle_button(player_id, button, pressed)
                
                elif action == 'analog':
                    stick = cmd.get('stick')
                    x = cmd.get('x', 0.0)
                    y = cmd.get('y', 0.0)
                    handle_analog(player_id, stick, x, y)
                
                elif action == 'init':
                    controller_type = cmd.get('controllerType')
                    if controller_type in ('xbox', 'ds4'):
                        # A different type needs a different virtual device.
                        if player_id in controllers and uses_ds4(player_id) != (controller_type == 'ds4'):
                            handle_disconnect(player_id)
                        player_types[player_id] = controller_type
                    # Pre-create controller so emulator sees it
                    get_or_create_controller(player_id)
                    log(f"P{player_id} controller initialized")
                
                elif action == 'disconnect':
                    handle_disconnect(player_id)
                
                else:
                    log(f"Unknown action: {action}")
            
            except json.JSONDecodeError as e:
                log(f"JSON decode error: {e}")
            except Exception as e:
                log(f"Error processing command: {e}")
    
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        # Cleanup all controllers
        for player_id in list(controllers.keys()):
            handle_disconnect(player_id)
        log("Cleanup complete")


if __name__ == "__main__":
    main()
