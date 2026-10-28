// A bounded "have I seen this id" set. Map keeps insertion order, so the oldest
// entry is the first key; a hit is re-inserted to count as recent.
export class LruSet {
  private readonly items = new Map<string, true>();
  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  // Returns true when the key was new (and is now remembered).
  add(key: string): boolean {
    if (this.items.has(key)) {
      this.items.delete(key);
      this.items.set(key, true);
      return false;
    }
    this.items.set(key, true);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
