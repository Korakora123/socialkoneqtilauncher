/** One job (or profile test) per AdsPower profile at a time — CLAUDE.md rule. */
export class ProfileLocks {
  private readonly held = new Map<string, string>();

  tryAcquire(profileId: string, owner: string): boolean {
    if (this.held.has(profileId)) return false;
    this.held.set(profileId, owner);
    return true;
  }

  release(profileId: string, owner: string): void {
    if (this.held.get(profileId) === owner) this.held.delete(profileId);
  }

  isLocked(profileId: string): boolean { return this.held.has(profileId); }
  get size(): number { return this.held.size; }
}
