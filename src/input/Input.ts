// Unified keyboard, mouse and gamepad input with GTA V-style helicopter bindings.
//
//            Controller        Keyboard
// Throttle   RT / LT           W / S
// Yaw        LB / RB           A / D
// Pitch/roll Left stick        Arrow keys / Numpad 8-5-4-6
// Camera     Right stick       Mouse (click to capture)

export interface FlightInput {
  /** -1 descend .. +1 climb. */
  collective: number;
  /** -1 left .. +1 right. */
  yaw: number;
  /** -1 nose up (back) .. +1 nose down (forward). */
  pitch: number;
  /** -1 bank left .. +1 bank right. */
  roll: number;
}

export interface FrameInput extends FlightInput {
  /** Camera orbit rate from the right stick, -1..1. */
  lookX: number;
  lookY: number;
  /** Mouse movement in pixels since the last frame. */
  mouseX: number;
  mouseY: number;
  zoom: number;
  actions: Set<Action>;
  /** True when the last input that moved anything came from a controller. */
  usingGamepad: boolean;
}

export type Action =
  | 'map'
  | 'pause'
  | 'help'
  | 'searchlight'
  | 'camera'
  | 'timeFaster'
  | 'timeSlower'
  | 'next'
  | 'prev'
  | 'up'
  | 'down'
  | 'back'
  | `overlay${number}`;

const KEY_ACTIONS: Record<string, Action> = {
  KeyM: 'map',
  Escape: 'pause',
  KeyP: 'pause',
  KeyH: 'help',
  KeyL: 'searchlight',
  KeyC: 'camera',
  BracketRight: 'timeFaster',
  BracketLeft: 'timeSlower',
  Tab: 'next',
};

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping).
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS: [number, Action][] = [
  [PAD.VIEW, 'map'],
  [PAD.MENU, 'pause'],
  [PAD.Y, 'searchlight'],
  [PAD.R3, 'camera'],
  [PAD.RIGHT, 'timeFaster'],
  [PAD.LEFT, 'timeSlower'],
  [PAD.RB, 'next'],
  [PAD.LB, 'prev'],
  [PAD.UP, 'up'],
  [PAD.DOWN, 'down'],
  [PAD.B, 'back'],
];

const STICK_DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;

/** Radial deadzone, rescaled so output still starts at 0 and reaches 1. */
function stick(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < STICK_DEADZONE) return [0, 0];
  const scaled = Math.min(1, (len - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return [(x / len) * scaled, (y / len) * scaled];
}

const trigger = (v: number) => (v < TRIGGER_DEADZONE ? 0 : (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));

export class Input {
  onGamepadChange: (name: string | null) => void = () => {};

  private down = new Set<string>();
  private pressed = new Set<Action>();
  private mouseX = 0;
  private mouseY = 0;
  private wheel = 0;
  private padPrev: boolean[] = [];
  private padIndex: number | null = null;
  private usingGamepad = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      if (!e.repeat) {
        const action = KEY_ACTIONS[e.code];
        if (action) this.pressed.add(action);
        if (e.code === 'ArrowUp') this.pressed.add('up');
        if (e.code === 'ArrowDown') this.pressed.add('down');
        if (e.code === 'ArrowLeft') this.pressed.add('prev');
        if (e.code === 'ArrowRight') this.pressed.add('next');
        if (e.code === 'Escape') this.pressed.add('back');
        if (/^Digit[1-9]$/.test(e.code)) this.pressed.add(`overlay${Number(e.code.slice(5))}`);
      }
      this.down.add(e.code);
      this.usingGamepad = false;
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        this.mouseX += e.movementX;
        this.mouseY += e.movementY;
        this.usingGamepad = false;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('gamepadconnected', (e) => {
      if (this.padIndex === null) {
        this.padIndex = e.gamepad.index;
        this.onGamepadChange(e.gamepad.id);
      }
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.padIndex) {
        this.padIndex = null;
        this.onGamepadChange(null);
      }
    });
  }

  releasePointer(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private key(...codes: string[]): number {
    return codes.some((c) => this.down.has(c)) ? 1 : 0;
  }

  poll(): FrameInput {
    const actions = this.pressed;
    this.pressed = new Set();

    let collective = this.key('KeyW', 'ShiftLeft') - this.key('KeyS', 'ControlLeft');
    let yaw = this.key('KeyD') - this.key('KeyA');
    let pitch = this.key('ArrowUp', 'Numpad8') - this.key('ArrowDown', 'Numpad5', 'Numpad2');
    let roll = this.key('ArrowRight', 'Numpad6') - this.key('ArrowLeft', 'Numpad4');
    let lookX = 0;
    let lookY = 0;

    const pad = this.padIndex !== null ? navigator.getGamepads?.()[this.padIndex] : null;
    if (pad) {
      const b = (i: number) => pad.buttons[i]?.pressed ?? false;
      const v = (i: number) => pad.buttons[i]?.value ?? 0;
      const [lx, ly] = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      const [rx, ry] = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      const padCollective = trigger(v(PAD.RT)) - trigger(v(PAD.LT));
      const padYaw = (b(PAD.RB) ? 1 : 0) - (b(PAD.LB) ? 1 : 0);

      const active = lx || ly || rx || ry || padCollective || padYaw;
      if (active) this.usingGamepad = true;

      collective += padCollective;
      yaw += padYaw;
      roll += lx;
      pitch += -ly;
      lookX = rx;
      lookY = ry;

      PAD_ACTIONS.forEach(([button, action]) => {
        const now = b(button);
        if (now && !this.padPrev[button]) {
          actions.add(action);
          this.usingGamepad = true;
        }
        this.padPrev[button] = now;
      });
    }

    const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));
    const frame: FrameInput = {
      collective: clamp1(collective),
      yaw: clamp1(yaw),
      pitch: clamp1(pitch),
      roll: clamp1(roll),
      lookX,
      lookY,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
      zoom: this.wheel,
      actions,
      usingGamepad: this.usingGamepad,
    };
    this.mouseX = 0;
    this.mouseY = 0;
    this.wheel = 0;
    return frame;
  }
}
