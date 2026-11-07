/**
 * A tree view's data provider registered before the real one exists, so the
 * view never shows VS Code's "There is no data provider registered that can
 * provide view data" while the extension activates, and shows its
 * `viewsWelcome` loading text instead of a blank pane while the first
 * listing runs.
 *
 * `viewsWelcome` only shows for a view whose provider is registered and
 * returned no rows. So the root is answered with no rows until the real
 * provider is attached ({@link attach}) and a root request has been answered
 * empty at least one turn earlier; then one `onDidChangeTreeData` makes VS
 * Code ask again, and every request goes to the real provider from then on.
 * The view's own context key (`erdStudio.diagramsLoading`) is cleared by the
 * real provider's first listing, as before.
 */
import * as vscode from 'vscode';

type Target<T> = vscode.TreeDataProvider<T> & Partial<vscode.TreeDragAndDropController<T>>;

export class DeferredTreeDataProvider<T> implements vscode.TreeDataProvider<T>, vscode.TreeDragAndDropController<T>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<T | T[] | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private target: Target<T> | undefined;
  private targetChanged: vscode.Disposable | undefined;
  /** A root request was answered with no rows, and a turn has passed since. */
  private shownEmpty = false;
  private emptyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Requests go to the real provider. */
  private released = false;

  constructor(
    /** Read by VS Code when the view is created, before the real provider exists. */
    readonly dropMimeTypes: readonly string[] = [],
    readonly dragMimeTypes: readonly string[] = [],
  ) {}

  /** Whether requests now reach the real provider. */
  get isReleased(): boolean {
    return this.released;
  }

  /** The real provider: its changes are passed on, and it lists once the view has shown empty. */
  attach(target: Target<T>): void {
    if (this.target) throw new Error('DeferredTreeDataProvider: a provider is already attached');
    this.target = target;
    this.targetChanged = target.onDidChangeTreeData?.((e) => this.changed.fire(e));
    this.release();
  }

  getChildren(element?: T): vscode.ProviderResult<T[]> {
    if (!this.released) {
      // The welcome shows meanwhile; one turn later the real listing follows.
      this.emptyTimer ??= setTimeout(() => {
        this.shownEmpty = true;
        this.release();
      }, 0);
      return [];
    }
    return this.target!.getChildren(element);
  }

  getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return this.target!.getTreeItem(element);
  }

  getParent(element: T): vscode.ProviderResult<T> {
    return this.target?.getParent?.(element);
  }

  handleDrag(source: readonly T[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
    return this.target?.handleDrag?.(source, dataTransfer, token);
  }

  handleDrop(target: T | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
    return this.target?.handleDrop?.(target, dataTransfer, token);
  }

  private release(): void {
    if (this.released || !this.target || !this.shownEmpty) return;
    this.released = true;
    this.changed.fire(undefined);
  }

  dispose(): void {
    clearTimeout(this.emptyTimer);
    this.targetChanged?.dispose();
    this.changed.dispose();
  }
}
