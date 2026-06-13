import { createRoot, type Root } from 'react-dom/client';
import { KanbanApp } from './react/index';
import { KanbanViewModel } from './kanban-view-model';

export class InlineKanbanRenderer {
  private vm: KanbanViewModel;
  private el: HTMLElement;
  private root: Root | null = null;

  constructor(vm: KanbanViewModel, el: HTMLElement) {
    this.vm = vm;
    this.el = el;
  }

  mount(): void {
    this.root = createRoot(this.el);
    this.root.render(<KanbanApp viewModel={this.vm} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
