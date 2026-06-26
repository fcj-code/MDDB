import { createRoot, type Root } from 'react-dom/client';
import { GalleryApp } from './react/index';
import { GalleryViewModel } from './gallery-view-model';

export class InlineGalleryRenderer {
  private vm: GalleryViewModel;
  private el: HTMLElement;
  private root: Root | null = null;

  constructor(vm: GalleryViewModel, el: HTMLElement) {
    this.vm = vm;
    this.el = el;
  }

  mount(): void {
    this.root = createRoot(this.el);
    this.root.render(<GalleryApp viewModel={this.vm} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
