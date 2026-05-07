import { useEffect, useRef } from 'react';

/**
 * Step 1 — Welcome.
 *
 * Plain explainer copy from §8 Step 1 of the implementation plan. The
 * "Get started" CTA defers to the Wizard footer's Next button so all
 * forward-progress lives in one place; pressing Enter in the welcome
 * step also advances via the shell's keyboard handler.
 */
export type Step1WelcomeProps = {
  onNext: () => void;
};

export function Step1Welcome(props: Step1WelcomeProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Focus the CTA on mount so keyboard users land on the obvious target.
  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return (
    <section className="wizard-step wizard-step--welcome" aria-labelledby="step1-heading">
      <h2 id="step1-heading" className="wizard-step__heading">
        Welcome to df-syncer-windows
      </h2>
      <p className="wizard-step__copy">
        df-syncer-windows keeps your Dwarf Fortress saves, mods, and prefs in sync across your PCs by
        writing to a folder your cloud client (Proton Drive, OneDrive, Dropbox, etc.) is already
        mirroring. We never log into your cloud account.
      </p>
      <p className="wizard-step__copy">
        This wizard takes about a minute. You can change anything later in Settings.
      </p>
      <button
        ref={buttonRef}
        type="button"
        className="wizard-step__cta"
        onClick={props.onNext}
        data-testid="step1-cta"
      >
        Get started
      </button>
    </section>
  );
}
