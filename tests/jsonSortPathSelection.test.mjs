import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSortPathSelection } from '../src/components/utils/sortPathSelection.ts';

test('root and field autocomplete share all previous path composition branches', () => {
    const cases = [
        ['', 'users', 'users'], ['users','users','users'], ['us','users','users'],
        ['users.','name','users.name'], ['users[','0]','users[0]'], ['users[0]','name','users[0].name'],
        ['users[*]','name','users[*].name'], ['users[0].na','name','users[0].name'],
        ['users[0]na','name','users[0].name'], ['users[na','name','name'], ['na','name','name'],
        ['foo','bar','bar'], ['users[0].n','users[0].name','users[0].name'],
    ];
    for (const [context, selected, expected] of cases) assert.equal(resolveSortPathSelection(context, selected), expected, `${context} + ${selected}`);
});
