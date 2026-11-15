import { create } from 'zustand';

/**
 * The app's root layout element, so anything (e.g. a Manipulation) can
 * animate the whole interface. Kept apart from the Recipe store.
 */
interface AppElementStore {
  appElement: HTMLElement | null;
  setAppElement(el: HTMLElement | null): void;
}

export const useAppElement = create<AppElementStore>((set) => ({
  appElement: null,
  setAppElement: (appElement) => set({ appElement }),
}));
