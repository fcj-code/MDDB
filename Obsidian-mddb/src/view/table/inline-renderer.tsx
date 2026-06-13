import { createRoot, type Root } from 'react-dom/client';
import { TableApp } from './react/index';
import { TableViewModel } from './table-view-model';

export class InlineTableRenderer {
  private vm: TableViewModel;
  private el: HTMLElement;
  private root: Root | null = null;

  constructor(vm: TableViewModel, el: HTMLElement) {
    this.vm = vm;
    this.el = el;
  }

  mount(): void {
    this.root = createRoot(this.el);
    this.root.render(<TableApp viewModel={this.vm} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
