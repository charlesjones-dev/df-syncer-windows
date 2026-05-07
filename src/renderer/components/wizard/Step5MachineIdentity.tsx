import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { MACHINE_ID_REGEX, type Step5Payload } from '../../state/store';

/**
 * Step 5 — Machine Identity.
 *
 * Auto-fills with `os.hostname()` via `api.app.hostname()` on mount,
 * unless the draft already has a `machineId` (e.g. user hit Back). The
 * field is user-editable; validation is 1-32 chars, alphanumeric +
 * `.`, `-`, `_`. Invalid values surface inline; the wizard footer
 * gates Next via `canAdvance`.
 */
export type Step5MachineIdentityProps = {
  machineId: string | undefined;
  onChange: (payload: Step5Payload) => void;
};

export function Step5MachineIdentity(props: Step5MachineIdentityProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hostnameLoading, setHostnameLoading] = useState(false);
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const didSeed = useRef(false);

  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    if (props.machineId !== undefined && props.machineId !== '') {
      return; // Already populated (Back into this step).
    }
    let cancelled = false;
    (async () => {
      setHostnameLoading(true);
      setHostnameError(null);
      try {
        const host = await api.app.hostname();
        if (cancelled) return;
        // Sanitize the hostname to fit the validation regex; some
        // corp-AD hostnames contain spaces or punctuation we don't want.
        const sanitized = host.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'this-pc';
        props.onChange({ machineId: sanitized });
      } catch (err) {
        if (cancelled) return;
        setHostnameError(err instanceof Error ? err.message : String(err));
        props.onChange({ machineId: 'this-pc' });
      } finally {
        if (!cancelled) setHostnameLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props]);

  // Auto-focus the input on mount so the user can immediately type to override.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const value = props.machineId ?? '';
  const tooShort = value.length === 0;
  const tooLong = value.length > 32;
  const badChars = value.length > 0 && !MACHINE_ID_REGEX.test(value);

  let validationMessage: string | null = null;
  if (tooShort) {
    validationMessage = 'Required.';
  } else if (tooLong) {
    validationMessage = 'Too long — 32 characters or fewer.';
  } else if (badChars) {
    validationMessage = 'Use letters, numbers, and . - _ only.';
  }

  function handleInput(ev: React.ChangeEvent<HTMLInputElement>): void {
    props.onChange({ machineId: ev.target.value });
  }

  return (
    <section className="wizard-step wizard-step--machine" aria-labelledby="step5-heading">
      <h2 id="step5-heading" className="wizard-step__heading">
        Name this PC
      </h2>
      <p className="wizard-step__copy">
        df-syncer-windows tags every sync with a machine identifier so you can tell at a glance which PC
        last touched the cloud. We pre-filled it from your hostname; you can change it.
      </p>

      <div className="step5__field">
        <label htmlFor="step5-machine-id" className="step5__label">
          Machine identifier
        </label>
        <input
          id="step5-machine-id"
          ref={inputRef}
          type="text"
          className="step5__input"
          value={value}
          onChange={handleInput}
          maxLength={32}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={validationMessage !== null}
          aria-describedby={validationMessage ? 'step5-validation' : 'step5-help'}
          data-testid="step5-machine-input"
        />
        <p id="step5-help" className="step5__help">
          1–32 characters. Letters, numbers, and <code>.</code>, <code>-</code>, <code>_</code>.
        </p>
        {validationMessage && (
          <p
            id="step5-validation"
            className="wizard-step__error"
            role="alert"
            data-testid="step5-validation"
          >
            {validationMessage}
          </p>
        )}
        {hostnameLoading && (
          <p className="wizard-step__status" role="status">
            Detecting hostname…
          </p>
        )}
        {hostnameError && !hostnameLoading && (
          <p className="wizard-step__status" role="status">
            Couldn&rsquo;t detect hostname: {hostnameError}. Defaulted to <code>this-pc</code>.
          </p>
        )}
      </div>
    </section>
  );
}
