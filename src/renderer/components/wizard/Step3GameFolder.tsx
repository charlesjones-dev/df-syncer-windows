import { useEffect, useState } from 'react';
import { api } from '../../api';
import { FolderPicker } from '../shared/FolderPicker';
import type { GameFolderSource } from '../../state/store';

/**
 * Step 3 — Game Folder.
 *
 * On mount we call `api.paths.detectGameFolder()` to autofill from
 * `%APPDATA%\Bay 12 Games\Dwarf Fortress` (or a Steam library scan).
 * The user can override via the picker. A heuristic looks for portable
 * mode by checking for `data\init` and `save` siblings on the chosen
 * path; if present we render a hint linking to the wiki.
 */
export type Step3GameFolderProps = {
  gameFolder: string | undefined;
  source: GameFolderSource;
  onChange: (gameFolder: string, source: GameFolderSource) => void;
};

const WIKI_URL = 'https://dwarffortresswiki.org/index.php/Game_folders_and_files';

/**
 * Heuristic portable-mode detection.
 *
 * The spec says: "if the chosen path contains both `data/init/` and
 * `save/` siblings". We can't stat the filesystem from the renderer, so
 * we infer from the path shape: any DF folder *not* living under the
 * canonical `AppData\Roaming\Bay 12 Games\Dwarf Fortress` location is a
 * strong signal of a portable Steam install (e.g. inside the Steam
 * library, `C:\Games\df_50_15_win64\`, etc.).
 *
 * Phase 11 may upgrade this to a real fs-stat check in the main process
 * via a new `paths:probePortable` IPC.
 */
export function looksPortable(p: string): boolean {
  if (!p) return false;
  const normalized = p.replace(/\\/g, '/').toLowerCase();
  // Standard Steam-Edition install: never portable. (Trim trailing /.)
  if (/\/appdata\/roaming\/bay 12 games\/dwarf fortress\/?$/.test(normalized)) {
    return false;
  }
  // A path under `%APPDATA%` but inside Bay 12 Games is the canonical
  // location regardless of trailing components.
  if (/\/appdata\/roaming\/bay 12 games\//.test(normalized)) {
    return false;
  }
  // Anything else that *names* a DF-shaped folder (Steam library
  // install, manual portable extraction, etc.) is likely portable.
  return /(?:\/df[_-]?\d|\/dwarf[_ -]?fortress|\/portable)/i.test(normalized);
}

export function Step3GameFolder(props: Step3GameFolderProps): JSX.Element {
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  // Track whether we've fired the auto-detect effect so we don't stomp
  // a manual selection if the component re-mounts (e.g. via Back/Next).
  const [didDetect, setDidDetect] = useState(false);

  useEffect(() => {
    if (didDetect) return;
    if (props.gameFolder) {
      // Already populated (Back into this step). Don't re-detect.
      setDidDetect(true);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetecting(true);
      setDetectError(null);
      try {
        const found = await api.paths.detectGameFolder();
        if (cancelled) return;
        if (found) {
          props.onChange(found, 'detected');
        } else {
          props.onChange('', 'none');
        }
      } catch (err) {
        if (cancelled) return;
        setDetectError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setDetecting(false);
          setDidDetect(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [didDetect, props]);

  function handlePick(path: string): void {
    props.onChange(path, 'manual');
  }

  const portable = looksPortable(props.gameFolder ?? '');
  const detected = props.source === 'detected' && Boolean(props.gameFolder);
  const missing = props.source === 'none' || !props.gameFolder;

  return (
    <section className="wizard-step wizard-step--game" aria-labelledby="step3-heading">
      <h2 id="step3-heading" className="wizard-step__heading">
        Find your Dwarf Fortress game folder
      </h2>
      <p className="wizard-step__copy">
        This is the folder containing your <code>save/</code>, <code>mods/</code>, and{' '}
        <code>prefs/</code> directories. We&rsquo;ll try to find it automatically.
      </p>

      {detecting && (
        <p className="wizard-step__status" role="status">
          Detecting...
        </p>
      )}

      {detectError && (
        <p className="wizard-step__error" role="alert" data-testid="step3-detect-error">
          Auto-detect failed: {detectError}
        </p>
      )}

      <FolderPicker
        label="Game folder"
        dialogLabel="Pick your Dwarf Fortress game folder"
        value={props.gameFolder ?? ''}
        onPick={handlePick}
      />

      <div className="wizard-step__badge-row">
        {detected && (
          <span
            className="wizard-step__badge wizard-step__badge--ok"
            data-testid="step3-detected-badge"
            aria-label="auto-detected"
          >
            <span aria-hidden="true">&#x2713;</span> Auto-detected
          </span>
        )}
        {props.source === 'manual' && (
          <span
            className="wizard-step__badge wizard-step__badge--info"
            data-testid="step3-manual-badge"
          >
            Manual override
          </span>
        )}
        {missing && !detecting && (
          <span
            className="wizard-step__badge wizard-step__badge--warn"
            data-testid="step3-missing-badge"
            aria-label="not detected"
          >
            <span aria-hidden="true">&#x26A0;</span> Not detected — please pick manually
          </span>
        )}
      </div>

      {portable && (
        <div
          className="wizard-step__validation wizard-step__validation--info"
          role="note"
          data-testid="step3-portable-banner"
        >
          <p>
            <strong>Looks like a portable install.</strong> The wiki has notes on portable mode:
          </p>
          {/* Phase 11 will wire app.openExternal so links open in the
              user's browser via shell.openExternal. Until then, plain
              `<a target="_blank">` is the right primitive. */}
          <a
            href={WIKI_URL}
            target="_blank"
            rel="noreferrer"
            className="wizard-step__link"
            data-testid="step3-wiki-link"
          >
            dwarffortresswiki.org / Game folders and files
          </a>
        </div>
      )}
    </section>
  );
}
