/** A field of the small sheet `ask` opens. */
export interface Field {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
}

export interface DialogSpec {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly Field[];
  readonly submit?: string;
}

interface Open extends DialogSpec {
  readonly resolve: (values: Record<string, string> | undefined) => void;
}

/** A small sheet with a few fields, in the page's own style: the browser's `prompt` is neither styled nor kind. */
class Dialogs {
  open = $state<Open | null>(null);

  ask(spec: DialogSpec): Promise<Record<string, string> | undefined> {
    this.open?.resolve(undefined);
    return new Promise((resolve) => {
      this.open = {
        ...spec,
        resolve: (values) => {
          this.open = null;
          resolve(values);
        },
      };
    });
  }
}

export const dialogs = new Dialogs();
