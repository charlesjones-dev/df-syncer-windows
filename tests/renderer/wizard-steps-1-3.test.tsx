import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardShell } from '../../src/renderer/components/wizard/WizardShell';
import {
  INITIAL_WIZARD_STATE,
  WIZARD_STEP_LABELS,
  canAdvance,
  wizardReducer
} from '../../src/renderer/state/store';
import { looksPortable } from '../../src/renderer/components/wizard/Step3GameFolder';

/**
 * Renderer tests for Phase 7 — wizard shell + steps 1-3.
 *
 * These exercise the user-visible behavior, mock `window.df` with vi.fn,
 * and assert via standard `expect` (no jest-dom).
 */

type DfMock = {
  config: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    isFirstRun: ReturnType<typeof vi.fn>;
  };
  paths: {
    detectGameFolder: ReturnType<typeof vi.fn>;
    validateCloudFolder: ReturnType<typeof vi.fn>;
    pickFolder: ReturnType<typeof vi.fn>;
  };
};

function installDfMock(overrides: Partial<DfMock['paths']> = {}): DfMock {
  const mock: DfMock = {
    config: {
      get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      save: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      isFirstRun: vi.fn().mockResolvedValue({ ok: true, data: true })
    },
    paths: {
      detectGameFolder: overrides.detectGameFolder
        ? overrides.detectGameFolder
        : vi.fn().mockResolvedValue({ ok: true, data: null }),
      validateCloudFolder: overrides.validateCloudFolder
        ? overrides.validateCloudFolder
        : vi.fn().mockResolvedValue({
            ok: true,
            data: { ok: true, freeBytes: 18 * 1024 * 1024 * 1024 }
          }),
      pickFolder: overrides.pickFolder
        ? overrides.pickFolder
        : vi.fn().mockResolvedValue({ ok: true, data: null })
    }
  };
  Object.defineProperty(window, 'df', {
    value: mock,
    writable: true,
    configurable: true
  });
  return mock;
}

describe('wizardReducer (pure)', () => {
  it('canAdvance gates Step 2 on a clean validation', () => {
    let state = INITIAL_WIZARD_STATE;
    state = wizardReducer(state, { type: 'next' });
    expect(state.stepIndex).toBe(1);
    expect(canAdvance(state)).toBe(false);

    state = wizardReducer(state, {
      type: 'setStep2',
      cloudFolder: 'C:/Cloud',
      validation: { ok: true, freeBytes: 100 }
    });
    expect(canAdvance(state)).toBe(true);
  });

  it('canAdvance blocks Step 2 hard-fails', () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: 'next' });
    state = wizardReducer(state, {
      type: 'setStep2',
      cloudFolder: 'C:/x',
      validation: { ok: false, reason: 'not writable' }
    });
    expect(canAdvance(state)).toBe(false);
  });

  it('canAdvance requires soft-warn ack', () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: 'next' });
    state = wizardReducer(state, {
      type: 'setStep2',
      cloudFolder: 'C:/y',
      validation: { ok: true, reason: 'under appdata', freeBytes: 1 }
    });
    expect(canAdvance(state)).toBe(false);
    state = wizardReducer(state, { type: 'acceptStep2SoftWarn' });
    expect(canAdvance(state)).toBe(true);
  });

  it('preserves draft across Back/Next', () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: 'next' });
    state = wizardReducer(state, {
      type: 'setStep2',
      cloudFolder: 'C:/Cloud',
      validation: { ok: true, freeBytes: 1 }
    });
    state = wizardReducer(state, { type: 'next' });
    state = wizardReducer(state, {
      type: 'setStep3',
      gameFolder: 'C:/DF',
      source: 'manual'
    });
    state = wizardReducer(state, { type: 'back' });
    expect(state.stepIndex).toBe(1);
    expect(state.draft.cloudFolder).toBe('C:/Cloud');
    expect(state.draft.gameFolder).toBe('C:/DF');
  });
});

describe('looksPortable heuristic', () => {
  it('flags portable-style paths', () => {
    expect(looksPortable('C:/Games/df_50_15_win64')).toBe(true);
    expect(looksPortable('D:/Portable/dwarf-fortress')).toBe(true);
  });

  it('does not flag the standard install', () => {
    expect(looksPortable('C:/Users/me/AppData/Roaming/Bay 12 Games/Dwarf Fortress')).toBe(false);
    expect(looksPortable('')).toBe(false);
  });
});

describe('WizardShell — Step 1 Welcome', () => {
  beforeEach(() => {
    installDfMock();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders welcome copy and Next button', () => {
    render(<WizardShell onExit={() => {}} />);
    expect(screen.getByRole('heading', { name: /welcome to df-syncer-windows/i })).not.toBeNull();
    expect(screen.getByText(/cloud client/i)).not.toBeNull();
    const nextBtn = screen.getByTestId('wizard-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    const cta = screen.getByTestId('step1-cta') as HTMLButtonElement;
    expect(cta.textContent).toMatch(/get started/i);
  });

  it('shows step indicator with correct label', () => {
    render(<WizardShell onExit={() => {}} />);
    const indicator = screen.getByTestId('wizard-step-indicator');
    expect(indicator.textContent).toContain('Step 1 of 7');
    expect(indicator.textContent).toContain(WIZARD_STEP_LABELS[0]);
  });
});

describe('WizardShell — Step 2 cloud folder', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('disables Next until a clean validation arrives', async () => {
    installDfMock({
      pickFolder: vi.fn().mockResolvedValue({ ok: true, data: 'C:/Cloud' }),
      validateCloudFolder: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: true, freeBytes: 21474836480 }
      })
    });
    const user = userEvent.setup();
    render(<WizardShell onExit={() => {}} />);

    // Move to step 2.
    await user.click(screen.getByTestId('wizard-next'));

    expect((screen.getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: /browse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('step2-ok')).not.toBeNull();
    });
    expect(screen.getByTestId('step2-ok').textContent).toMatch(/20\.0 GB/);
    expect((screen.getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks Next on hard-fail and unblocks on soft-warn after acknowledgement', async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ok: false, reason: 'not writable' } })
      .mockResolvedValueOnce({
        ok: true,
        data: { ok: true, reason: 'under %APPDATA%', freeBytes: 1024 ** 3 }
      });
    const pick = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: 'C:/bad' })
      .mockResolvedValueOnce({ ok: true, data: 'C:/warned' });
    installDfMock({ pickFolder: pick, validateCloudFolder: validate });

    const user = userEvent.setup();
    render(<WizardShell onExit={() => {}} />);
    await user.click(screen.getByTestId('wizard-next'));

    // Hard fail.
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.getByTestId('step2-hardfail')).not.toBeNull();
    });
    expect((screen.getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(true);

    // Pick again — soft warn.
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.getByTestId('step2-softwarn')).not.toBeNull();
    });
    expect((screen.getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(true);

    // Accept the soft-warn.
    await user.click(screen.getByTestId('step2-accept-warn'));
    expect(screen.getByTestId('step2-accepted')).not.toBeNull();
    expect((screen.getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('WizardShell — Step 3 game folder', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('prefills detected path and shows the auto-detected badge', async () => {
    installDfMock({
      detectGameFolder: vi
        .fn()
        .mockResolvedValue({ ok: true, data: 'C:/Users/x/AppData/Roaming/Bay 12 Games/Dwarf Fortress' }),
      pickFolder: vi.fn().mockResolvedValue({ ok: true, data: 'C:/Cloud' }),
      validateCloudFolder: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { ok: true, freeBytes: 1024 ** 3 } })
    });

    const user = userEvent.setup();
    render(<WizardShell onExit={() => {}} />);

    // Step 1 -> 2 -> 3.
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.getByTestId('step2-ok')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    await waitFor(() => {
      expect(screen.getByTestId('step3-detected-badge')).not.toBeNull();
    });
    // The folder-picker input is labelled "Game folder" exactly. Use an
    // exact-match string to avoid matching the section heading
    // "Find your Dwarf Fortress game folder".
    const input = screen.getByLabelText('Game folder') as HTMLInputElement;
    expect(input.value).toMatch(/Bay 12 Games/);
  });

  it('replaces value on manual pick and shows portable banner for portable paths', async () => {
    installDfMock({
      detectGameFolder: vi.fn().mockResolvedValue({ ok: true, data: null }),
      pickFolder: vi
        .fn()
        // Step 2 cloud pick.
        .mockResolvedValueOnce({ ok: true, data: 'C:/Cloud' })
        // Step 3 manual pick — portable-style path.
        .mockResolvedValueOnce({ ok: true, data: 'C:/Games/df_50_15_win64' }),
      validateCloudFolder: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { ok: true, freeBytes: 1024 ** 3 } })
    });

    const user = userEvent.setup();
    render(<WizardShell onExit={() => {}} />);
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.getByTestId('step2-ok')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    await waitFor(() => {
      expect(screen.getByTestId('step3-missing-badge')).not.toBeNull();
    });

    // Step 3 is the only step rendered, so there's exactly one Browse
    // button visible.
    await user.click(screen.getByRole('button', { name: /browse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('step3-portable-banner')).not.toBeNull();
    });
    const link = screen.getByTestId('step3-wiki-link') as HTMLAnchorElement;
    expect(link.href).toMatch(/dwarffortresswiki\.org/);
    expect(link.target).toBe('_blank');
  });
});

describe('WizardShell — Cancel and ESC prompt', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Cancel triggers confirm and exits when accepted', async () => {
    installDfMock();
    const onExit = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    render(<WizardShell onExit={onExit} />);
    await user.click(screen.getByTestId('wizard-cancel'));

    expect(confirmSpy).toHaveBeenCalledWith('Discard setup?');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Cancel does not exit when user declines', async () => {
    installDfMock();
    const onExit = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const user = userEvent.setup();
    render(<WizardShell onExit={onExit} />);
    await user.click(screen.getByTestId('wizard-cancel'));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('ESC key triggers the same confirm flow', async () => {
    installDfMock();
    const onExit = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<WizardShell onExit={onExit} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(confirmSpy).toHaveBeenCalledWith('Discard setup?');
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
