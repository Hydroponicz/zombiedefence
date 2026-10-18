// The developer console: ` (the backquote key, keyboard only) opens and closes it. Switches that
// change how the game behaves for testing, clickable or typed as commands ("popups off"). Settings
// are kept in the browser between sessions.

const STORAGE_KEY = 'zd-dev-settings';

export interface DevSettings {
  /**
   * Radio calls pop up and hold the game: Command's requests and its call on movement restrictions.
   * Off, requests still come in (to the log and Flight Command) and restrictions are set in Flight Command.
   */
  popups: boolean;
}

const DEFAULTS: DevSettings = { popups: true };

/** The switches, by command name. */
const SWITCHES: { name: string; key: keyof DevSettings; label: string }[] = [
  { name: 'popups', key: 'popups', label: 'Radio call pop-ups (requests and Command decisions)' },
];

function load(): DevSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    // Saved before the switch covered every call.
    if (saved.requestPopups !== undefined && saved.popups === undefined) saved.popups = saved.requestPopups;
    delete saved.requestPopups;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export class DevConsole {
  readonly settings = load();
  private el = document.createElement('div');
  private list = document.createElement('div');
  private log = document.createElement('div');
  private input = document.createElement('input');

  /** @param opened called when the console opens (to free the mouse) */
  constructor(private opened: () => void) {
    this.el.id = 'dev-console';
    this.el.hidden = true;
    const title = document.createElement('div');
    title.className = 'dc-title';
    title.textContent = 'Dev console · ` to close · type "help"';
    this.list.className = 'dc-switches';
    this.log.className = 'dc-log';
    this.input.className = 'dc-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.el.append(title, this.list, this.log, this.input);
    document.body.append(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Backquote') return;
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    }, true);
    // Typing here doesn't fly the helicopter.
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        this.run(this.input.value);
        this.input.value = '';
      } else if (e.code === 'Escape') this.toggle();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.list.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (!row) return;
      const key = row.dataset.key as keyof DevSettings;
      this.set(key, !this.settings[key]);
    });
    this.render();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  private toggle(): void {
    this.el.hidden = !this.el.hidden;
    if (this.el.hidden) {
      this.input.blur();
      return;
    }
    this.opened();
    this.input.focus();
  }

  private set(key: keyof DevSettings, value: boolean): void {
    this.settings[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Not kept between sessions, then.
    }
    const s = SWITCHES.find((x) => x.key === key)!;
    this.print(`${s.label}: ${value ? 'on' : 'off'}`);
    this.render();
  }

  private run(line: string): void {
    const [name, arg] = line.trim().toLowerCase().split(/\s+/);
    if (!name) return;
    this.print(`> ${line.trim()}`);
    if (name === 'help') {
      for (const s of SWITCHES) this.print(`${s.name} on|off — ${s.label}`);
      return;
    }
    const s = SWITCHES.find((x) => x.name === name);
    if (!s) {
      this.print(`Unknown command "${name}". Type "help".`);
      return;
    }
    if (arg !== undefined && arg !== 'on' && arg !== 'off') {
      this.print(`Usage: ${s.name} on|off`);
      return;
    }
    this.set(s.key, arg === undefined ? !this.settings[s.key] : arg === 'on');
  }

  private print(text: string): void {
    const line = document.createElement('div');
    line.textContent = text;
    this.log.append(line);
    while (this.log.childElementCount > 8) this.log.firstElementChild!.remove();
  }

  private render(): void {
    this.list.innerHTML = SWITCHES.map((s) => `<div class="dc-switch" data-key="${s.key}">
      <span>${s.label} <small>(${s.name})</small></span><b class="${this.settings[s.key] ? 'on' : 'off'}">${this.settings[s.key] ? 'ON' : 'OFF'}</b></div>`).join('');
  }
}
