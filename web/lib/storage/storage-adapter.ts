export interface StorageAdapter<TState> {
  read(): TState;
  write(next: TState): void;
  update(mutator: (current: TState) => TState): TState;
}
