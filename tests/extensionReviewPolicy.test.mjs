import assert from 'node:assert/strict';
import test from 'node:test';
import {
    REVIEW_TYPE, REVIEW_STORAGE_KEY, REVIEW_STORE_URL, REVIEW_DAY_MS, REVIEW_MIN_AGE_MS,
    REVIEW_USAGE_INTERVAL_MS, REVIEW_COOLDOWN_MS, REVIEW_MAX_SHOWS, REVIEW_CLAIM_TTL_MS,
    normalizeReviewState, isReviewEligible, recordReviewUsage, reviewDayKey,
} from '../public/json-review-policy.js';
import { createReviewController } from '../public/json-review-background.js';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const baseTime = Date.UTC(2026,0,10,12);
const sessionId = uuid(9000);
const clone = value => structuredClone(value);
const eligibleState = (now=baseTime) => ({...normalizeReviewState(undefined,now-REVIEW_MIN_AGE_MS),totalUses:10,
    activeDays:[3,2,1].map(day=>reviewDayKey(now-day*REVIEW_DAY_MS)),lastCountedAt:now-REVIEW_USAGE_INTERVAL_MS});
function fixture({state, time=baseTime}={}) {
    const stored = state === undefined ? {} : {[REVIEW_STORAGE_KEY]:clone(state)};
    let current=time,sequence=100,failGet=false,failSet=false,failOpen=false;
    const opened=[],writes=[];
    const api={runtime:{id:'review-test',getURL:path=>'chrome-extension://review-test/'+path},
        storage:{local:{async get(key){if(failGet)throw Error('read failed');return {[key]:clone(stored[key])};},async set(value){if(failSet)throw Error('write failed');Object.assign(stored,clone(value));writes.push(clone(value));}}},
        tabs:{async create(value){if(failOpen)throw Error('open failed');opened.push(clone(value));return {id:100+opened.length};}}};
    let controller=createReviewController({chrome:api,now:()=>current,randomId:()=>uuid(++sequence)});
    const sender=(tabId=1)=>({id:api.runtime.id,url:api.runtime.getURL('index.html'),tab:{id:tabId},frameId:0,documentLifecycle:'active'});
    const call=(action,details={},from=sender())=>controller.handle({type:REVIEW_TYPE,sessionId,action,...details},from);
    return {api,stored,opened,writes,sender,call,get controller(){return controller;},get state(){return stored[REVIEW_STORAGE_KEY];},get time(){return current;},
        advance(value){current+=value;},setTime(value){current=value;},failRead(value){failGet=value;},failWrite(value){failSet=value;},failOpen(value){failOpen=value;},
        restart(){controller=createReviewController({chrome:api,now:()=>current,randomId:()=>uuid(++sequence)});}};
}
async function shown(f,from=f.sender(),session=sessionId){const claim=await f.call('claim',{sessionId:session},from);assert.equal(claim.granted,true);assert.equal((await f.call('shown',{sessionId:session,token:claim.token},from)).ok,true);return claim;}

test('first observation starts a quiet seven-day window and initialization or updates never reset it',async()=>{
    const f=fixture();await f.controller.initialize();assert.equal(f.state.firstSeenAt,baseTime);assert.equal(isReviewEligible(f.state,f.time),false);
    f.advance(8*REVIEW_DAY_MS);await f.controller.initialize();f.restart();await f.call('initialize');assert.equal(f.state.firstSeenAt,baseTime);assert.equal(f.state.totalUses,0);assert.deepEqual(f.opened,[]);
});
test('eligibility requires all age, effective-use and distinct-day thresholds',()=>{
    const state=eligibleState();assert.equal(isReviewEligible(state,baseTime),true);
    for(const altered of [{...state,firstSeenAt:baseTime-REVIEW_MIN_AGE_MS+1},{...state,totalUses:9},{...state,activeDays:state.activeDays.slice(0,2)},{...state,suppressed:true},{...state,shownCount:REVIEW_MAX_SHOWS},{...state,cooldownUntil:baseTime+1}])assert.equal(isReviewEligible(altered,baseTime),false);
});
test('successful operations count at most once per minute and repeated event IDs never count again',async()=>{
    const f=fixture();await f.call('used',{eventId:uuid(1),kind:'format'});assert.equal(f.state.totalUses,1);
    await f.call('used',{eventId:uuid(2),kind:'compress'});assert.equal(f.state.totalUses,1);
    f.advance(REVIEW_USAGE_INTERVAL_MS);await f.call('used',{eventId:uuid(1),kind:'format'});assert.equal(f.state.totalUses,1);
    await f.call('used',{eventId:uuid(3),kind:'import'});assert.equal(f.state.totalUses,2);assert.equal(f.state.activeDays.length,1);
});
test('active days are distinct local dates and event retention remains bounded',()=>{
    let state=normalizeReviewState(undefined,baseTime);
    for(let day=0;day<5;day++)for(let use=0;use<10;use++)state=recordReviewUsage(state,uuid(day*10+use+1),'format',baseTime+day*REVIEW_DAY_MS+use*REVIEW_USAGE_INTERVAL_MS);
    assert.equal(state.totalUses,50);assert.equal(state.activeDays.length,3);assert.equal(new Set(state.activeDays).size,3);assert.equal(state.recentEventIds.length,32);
    assert.equal(JSON.stringify(state).includes('format'),false,'operation names and processing data are not stored as a usage log');
});
test('invalid stored data restarts quietly while explicit opt-out and show cap remain respected',()=>{
    for(const raw of [null,false,'data',[],{}, {schemaVersion:99,totalUses:100,activeDays:['2026-01-01','2026-01-02','2026-01-03']},{schemaVersion:1,firstSeenAt:'old',totalUses:100}]){
        const state=normalizeReviewState(raw,baseTime);assert.equal(state.firstSeenAt,baseTime);assert.equal(isReviewEligible(state,baseTime),false);
    }
    const state=normalizeReviewState({schemaVersion:99,suppressed:true,shownCount:999,secret:'never retain this'},baseTime);
    assert.equal(state.suppressed,true);assert.equal(state.shownCount,2);assert.equal(Object.hasOwn(state,'secret'),false);
});
test('malformed day keys, counters and event IDs do not produce premature eligibility',()=>{
    const value={...eligibleState(),totalUses:NaN,activeDays:['bad','2026-02-31','2026-13-01'],recentEventIds:['junk'],lastCountedAt:Infinity};
    const state=normalizeReviewState(value,baseTime);assert.equal(state.totalUses,0);assert.deepEqual(state.activeDays,[]);assert.deepEqual(state.recentEventIds,[]);assert.equal(state.lastCountedAt,0);assert.equal(isReviewEligible(state,baseTime),false);
});
test('clock rollback does not add rapid uses or bypass invitation age and cooldown',async()=>{
    const f=fixture({state:eligibleState()});await f.call('used',{eventId:uuid(1),kind:'format'});const count=f.state.totalUses;
    f.setTime(baseTime-2*REVIEW_DAY_MS);await f.call('used',{eventId:uuid(2),kind:'format'});assert.equal(f.state.totalUses,count);
    const state=normalizeReviewState({...eligibleState(),firstSeenAt:baseTime+REVIEW_DAY_MS,lastShownAt:baseTime+REVIEW_DAY_MS},baseTime);
    assert.equal(isReviewEligible(state,baseTime),false);
});
test('only trusted top-level editor pages can initialize, count usage or open the store',async()=>{
    const f=fixture({state:eligibleState()});
    for(const altered of [{...f.sender(),id:'foreign'},{...f.sender(),url:'https://example.com/'},{...f.sender(),url:f.api.runtime.getURL('other.html')},{...f.sender(),frameId:1},{...f.sender(),documentLifecycle:'prerender'},{...f.sender(),tab:undefined}]){
        assert.equal((await f.call('initialize',{},altered)).code,'SOURCE');assert.equal((await f.call('used',{eventId:uuid(1),kind:'format'},altered)).code,'SOURCE');
    }
    assert.equal((await f.call('initialize',{sessionId:'bad'})).code,'SOURCE');assert.deepEqual(f.opened,[]);assert.deepEqual(f.writes,[]);
});
test('editor capture query strings remain compatible with the trusted review source',async()=>{
    const f=fixture();assert.equal((await f.call('initialize',{}, {...f.sender(),url:f.api.runtime.getURL('index.html?capture=local')})).ok,true);
});
test('unsupported and malformed usage events leave local counters unchanged',async()=>{
    const f=fixture();await f.controller.initialize();const before=clone(f.state);
    for(const value of [{eventId:'bad',kind:'format'},{eventId:uuid(1),kind:'copy'},{eventId:uuid(2),kind:'failed-format'}])assert.equal((await f.call('used',value)).code,'EVENT');
    assert.deepEqual(f.state,before);
});
test('parallel editor tabs cannot claim the same eligible invitation',async()=>{
    const f=fixture({state:eligibleState()});const [a,b]=await Promise.all([f.call('claim'),f.call('claim',{sessionId:uuid(9001)},f.sender(2))]);
    assert.equal(a.granted,true);assert.equal(b.granted,false);assert.equal(f.state.lease.tabId,1);assert.equal(f.state.shownCount,0);
});
test('unshown leases expire and worker restarts retain live lease ownership',async()=>{
    const f=fixture({state:eligibleState()});const first=await f.call('claim');f.restart();assert.equal((await f.call('claim',{},f.sender(2))).granted,false);
    f.advance(REVIEW_CLAIM_TTL_MS);const next=await f.call('claim',{sessionId:uuid(9001)},f.sender(2));assert.equal(next.granted,true);assert.notEqual(next.token,first.token);
    assert.equal((await f.call('shown',{token:first.token})).code,'EXPIRED');assert.equal(f.state.shownCount,0);
});
test('claiming does not count as a display and duplicate shown messages count once',async()=>{
    const f=fixture({state:eligibleState()});const claim=await f.call('claim');assert.equal(f.state.shownCount,0);
    await f.call('shown',{token:claim.token});await f.call('shown',{token:claim.token});assert.equal(f.state.shownCount,1);assert.equal(f.state.lastShownAt,f.time);assert.equal(f.state.cooldownUntil,f.time+REVIEW_COOLDOWN_MS);
});
test('other sessions and tabs cannot show, decide or erase the current invitation',async()=>{
    const f=fixture({state:eligibleState()});const claim=await f.call('claim');const before=clone(f.state);
    assert.equal((await f.call('shown',{token:claim.token,sessionId:uuid(9001)})).code,'EXPIRED');assert.equal((await f.call('shown',{token:claim.token},f.sender(2))).code,'EXPIRED');
    assert.equal((await f.call('release',{token:claim.token},f.sender(2))).ok,true);assert.deepEqual(f.state,before);
    assert.equal((await f.call('decide',{token:claim.token,choice:'rate'},f.sender(2))).code,'EXPIRED');assert.deepEqual(f.opened,[]);
});
test('release permits a later claim without consuming a display and is idempotent',async()=>{
    const f=fixture({state:eligibleState()});const claim=await f.call('claim');await f.call('release',{token:claim.token});await f.call('release',{token:claim.token});assert.equal(f.state.lease,null);assert.equal(f.state.shownCount,0);assert.equal((await f.call('claim')).granted,true);
});
test('release after display cannot roll back the thirty-day cooldown or display count',async()=>{
    const f=fixture({state:eligibleState()});const claim=await shown(f);await f.call('release',{token:claim.token});assert.equal(f.state.shownCount,1);assert.equal((await f.call('claim')).granted,false);
});
test('later extends cooldown from the user decision and the second display is the last',async()=>{
    const f=fixture({state:eligibleState()});const first=await shown(f);f.advance(REVIEW_DAY_MS);await f.call('decide',{token:first.token,choice:'later'});
    const allowedAt=f.time+REVIEW_COOLDOWN_MS;f.setTime(allowedAt-1);assert.equal((await f.call('claim')).granted,false);f.setTime(allowedAt);
    const second=await shown(f);assert.equal(f.state.shownCount,2);await f.call('decide',{token:second.token,choice:'later'});f.advance(100*REVIEW_DAY_MS);assert.equal((await f.call('claim')).granted,false);
});
test('a displayed invitation can still be dismissed after its lease clock expires',async()=>{
    const f=fixture({state:eligibleState()});const claim=await shown(f);f.advance(REVIEW_DAY_MS);assert.equal((await f.call('decide',{token:claim.token,choice:'never'})).ok,true);assert.equal(f.state.suppressed,true);
});
test('never is permanent across worker restarts and later successes',async()=>{
    const f=fixture({state:eligibleState()});const claim=await shown(f);await f.call('decide',{token:claim.token,choice:'never'});const uses=f.state.totalUses;
    f.restart();f.advance(90*REVIEW_DAY_MS);const writes=f.writes.length;await f.call('used',{eventId:uuid(1),kind:'convert'});assert.equal(f.writes.length,writes);assert.equal(f.state.totalUses,uses);assert.equal((await f.call('claim')).granted,false);assert.deepEqual(f.opened,[]);
});
test('rate opens only the fixed official reviews link once and records a click, not a submitted review',async()=>{
    const f=fixture({state:eligibleState()});const claim=await shown(f);await f.call('decide',{token:claim.token,choice:'rate',url:'https://evil.example/'});f.restart();
    await f.call('decide',{token:claim.token,choice:'rate'});assert.deepEqual(f.opened,[{url:REVIEW_STORE_URL,active:true}]);assert.match(REVIEW_STORE_URL,/gjodfccabjefjicpjbbhfkgkddapafbh\/reviews$/);assert.equal(f.state.suppressionReason,'rate_clicked');assert.equal(Object.hasOwn(f.state,'reviewSubmitted'),false);assert.equal((await f.call('claim')).granted,false);
});
test('a store opening failure preserves the current invitation and can be retried',async()=>{
    const f=fixture({state:eligibleState()});const claim=await shown(f);f.failOpen(true);assert.equal((await f.call('decide',{token:claim.token,choice:'rate'})).code,'OPEN_FAILED');assert.equal(f.state.suppressed,false);assert.equal(f.state.lease.token,claim.token);
    f.failOpen(false);assert.equal((await f.call('decide',{token:claim.token,choice:'rate'})).ok,true);assert.equal(f.opened.length,1);
});
test('storage errors fail closed without displaying or opening an external page',async()=>{
    const f=fixture({state:eligibleState()});f.failRead(true);assert.equal((await f.call('claim')).ok,false);f.failRead(false);
    const claim=await shown(f);f.failWrite(true);assert.equal((await f.call('decide',{token:claim.token,choice:'rate'})).ok,false);assert.equal(f.opened.length,0);f.failWrite(false);assert.equal((await f.call('decide',{token:claim.token,choice:'rate'})).ok,true);
});
test('invalid invitation choices cannot decide a pending claim or navigate elsewhere',async()=>{
    const f=fixture({state:eligibleState()});const claim=await f.call('claim');assert.equal((await f.call('decide',{token:claim.token,choice:'rate'})).code,'STATE');await f.call('shown',{token:claim.token});assert.equal((await f.call('decide',{token:claim.token,choice:'five-stars'})).code,'CHOICE');assert.deepEqual(f.opened,[]);
});
test('missing cooldown fields on existing display metadata do not invite again early',()=>{
    const state=normalizeReviewState({...eligibleState(),shownCount:1,lastShownAt:baseTime-REVIEW_DAY_MS,cooldownUntil:undefined},baseTime);assert.equal(state.cooldownUntil,baseTime-REVIEW_DAY_MS+REVIEW_COOLDOWN_MS);assert.equal(isReviewEligible(state,baseTime),false);
});

test('usage counters stop once the lifetime invitation cap has been reached',async()=>{
    const f=fixture({state:{...eligibleState(),shownCount:2}});const before=clone(f.state);
    f.advance(60*REVIEW_DAY_MS);await f.call('used',{eventId:uuid(1),kind:'format'});
    assert.equal(f.state.totalUses,before.totalUses);assert.deepEqual(f.state.activeDays,before.activeDays);assert.deepEqual(f.state.recentEventIds,before.recentEventIds);assert.deepEqual(f.writes,[]);
});
