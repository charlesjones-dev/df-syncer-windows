import { useEffect, useState } from 'react';
import { api } from '../../api';
import { FolderPicker } from '../shared/FolderPicker';
import type { CloudFolderValidationSnapshot } from '../../state/store';
import type { CloudFolderValidation } from '@shared/types';

/**
 * Step 2 — Cloud-Drive Folder.
 *
 * The user picks the local folder that their cloud client mirrors.
 * On selection we immediately call `api.paths.validateCloudFolder` and
 * surface the result:
 *   - hard fail (`ok: false`) — block Next, show the reason as an error.
 *   - soft warn (`ok: true && reason`) — show a warning and require an
 *     explicit "Continue anyway" acknowledgement before Next is enabled.
 *   - clean (`ok: true && !reason`) — show free-bytes and let the user
 *     proceed.
 */
export type Step2CloudFolderProps = {
  /** Current snapshot from the wizard reducer (rendered as-is). */
  snapshot: CloudFolderValidationSnapshot | null;
  /** Reducer dispatcher: store a fresh path + validation result. */
  onPick: (path: string, validation: CloudFolderValidation) => void;
  /** Reducer dispatcher: user accepted the soft-warn reason. */
  onAcceptSoftWarn: () => void;
};

const ONE_GB = 1024 * 1024 * 1024;

function formatGb(freeBytes: number | undefined): string {
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes)) {
    return 'unknown';
  }
  return `${(freeBytes / ONE_GB).toFixed(1)} GB`;
}

export function Step2CloudFolder(props: Step2CloudFolderProps): JSX.Element {
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear any stale error when the snapshot changes from outside.
  useEffect(() => {
    setError(null);
  }, [props.snapshot?.path]);

  async function handlePick(path: string): Promise<void> {
    setValidating(true);
    setError(null);
    try {
      const validation = await api.paths.validateCloudFolder(path);
      props.onPick(path, validation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  const snapshot = props.snapshot;
  const hardFail = snapshot ? !snapshot.result.ok : false;
  const softWarn = snapshot ? snapshot.result.ok && Boolean(snapshot.result.reason) : false;
  const clean = snapshot ? snapshot.result.ok && !snapshot.result.reason : false;

  return (
    <section className="wizard-step wizard-step--cloud" aria-labelledby="step2-heading">
      <h2 id="step2-heading" className="wizard-step__heading">
        Pick your cloud-drive folder
      </h2>
      <p className="wizard-step__copy">
        Choose the local folder that your cloud client (Proton Drive, OneDrive, Dropbox, Google
        Drive, iCloud, etc.) already mirrors. df-syncer-windows writes a small{' '}
        <code>df-syncer-windows/</code> subfolder inside it.
      </p>

      <FolderPicker
        label="Cloud-drive folder"
        dialogLabel="Pick your cloud-drive folder"
        value={snapshot?.path ?? ''}
        onPick={handlePick}
        autoFocus
      />

      {validating && (
        <p className="wizard-step__status" role="status">
          Validating folder...
        </p>
      )}

      {error && (
        <p className="wizard-step__error" role="alert" data-testid="step2-error">
          {error}
        </p>
      )}

      {snapshot && hardFail && (
        <div
          className="wizard-step__validation wizard-step__validation--error"
          role="alert"
          data-testid="step2-hardfail"
        >
          <strong>Can&rsquo;t use this folder:</strong> {snapshot.result.reason ?? 'unknown error'}
        </div>
      )}

      {snapshot && softWarn && (
        <div
          className="wizard-step__validation wizard-step__validation--warn"
          role="alert"
          data-testid="step2-softwarn"
        >
          <p>
            <strong>Heads up:</strong> {snapshot.result.reason}
          </p>
          <p className="wizard-step__validation-meta">
            Free space: {formatGb(snapshot.result.freeBytes)}
          </p>
          {!snapshot.softWarnAccepted && (
            <button
              type="button"
              className="wizard-step__accept"
              onClick={props.onAcceptSoftWarn}
              data-testid="step2-accept-warn"
            >
              Continue anyway
            </button>
          )}
          {snapshot.softWarnAccepted && (
            <p className="wizard-step__accepted" data-testid="step2-accepted">
              Acknowledged. You can continue.
            </p>
          )}
        </div>
      )}

      {snapshot && clean && (
        <div className="wizard-step__validation wizard-step__validation--ok" data-testid="step2-ok">
          <p>
            <strong>Looks good.</strong> Free space: {formatGb(snapshot.result.freeBytes)}
          </p>
        </div>
      )}

      {snapshot && (
        <p className="wizard-step__note" data-testid="step2-existing-note">
          We&rsquo;ll detect any existing df-syncer-windows mirror at this folder during the first
          sync.
        </p>
      )}
    </section>
  );
}
