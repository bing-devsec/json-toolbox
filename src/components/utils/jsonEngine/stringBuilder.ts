// Bound intermediate string nodes when a large document is assembled from small fragments.
// Keep only a small batch of fragments, then flatten it before collecting the next batch.
export class ChunkedStringBuilder {
    private readonly chunks: string[] = [];
    private parts: string[] = [];
    private partLength = 0;

    append(value: string): void {
        if (!value) return;
        this.parts.push(value);
        this.partLength += value.length;
        if (this.partLength >= 64 * 1024 || this.parts.length >= 1024) {
            this.flush();
        }
    }

    private flush(): void {
        if (!this.parts.length) return;
        this.chunks.push(this.parts.join(''));
        this.parts = [];
        this.partLength = 0;
    }

    toString(): string {
        this.flush();
        return this.chunks.join('');
    }
}
