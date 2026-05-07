import { useId, useState } from 'react';
import { api } from '../../api';

/**
 * Reusable folder-picker control.
 *
 * Renders a labelled read-only path input alongside a "Browse..." button
 * that delegates to `api.paths.pickFolder` (`dialog.showOpenDialog` in
 * main). The component is presentational; callers handle validation and
 * any downstream effects via `onPick`.
 */
export type FolderPickerProps = {
  /** Visible label for the field. */
  label: string;
  /** Label passed to the native dialog title. */
  dialogLabel: string;
  /** Currently selected path, or empty string if none. */
  value: string;
  /** Called with the chosen path; not called if the user cancels. */
  onPick: (path: string) => void;
  /** Optional auto-focus on mount (used by step focus management). */
  autoFocus?: boolean;
  /** Optional id override; otherwise an auto id is used. */
  id?: string;
};

export function FolderPicker(props: FolderPickerProps): JSX.Element {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  const [picking, setPicking] = useState(false);

  async function handlePick(): Promise<void> {
    if (picking) return;
    setPicking(true);
    try {
      const result = await api.paths.pickFolder(props.dialogLabel);
      if (result) props.onPick(result);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="folder-picker">
      <label htmlFor={inputId} className="folder-picker__label">
        {props.label}
      </label>
      <div className="folder-picker__row">
        <input
          id={inputId}
          className="folder-picker__input"
          type="text"
          value={props.value}
          readOnly
          placeholder="(no folder selected)"
          aria-readonly="true"
        />
        <button
          type="button"
          className="folder-picker__button"
          onClick={handlePick}
          disabled={picking}
          autoFocus={props.autoFocus}
        >
          {picking ? 'Picking...' : 'Browse...'}
        </button>
      </div>
    </div>
  );
}
