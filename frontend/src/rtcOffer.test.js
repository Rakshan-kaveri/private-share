import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOfferAndAttach} from './rtcOffer.js';

test('answerer applies the offer before attaching microphone and camera', async () => {
  const events=[];
  const peer={signalingState:'stable',async setRemoteDescription(d){events.push('remote:'+d.type)},addTrack(t){events.push('track:'+t.kind);return {track:t}}};
  const stream={getTracks:()=>[{kind:'audio'},{kind:'video'}]};
  const senders=await applyOfferAndAttach(peer,{type:'offer'},stream);
  assert.deepEqual(events,['remote:offer','track:audio','track:video']);
  assert.equal(senders.length,2);
});

test('screen viewer answers without capturing or sending local media', async () => {
  const events=[];
  const peer={signalingState:'stable',async setRemoteDescription(){events.push('remote')},addTrack(){throw Error('unexpected local capture')}};
  assert.deepEqual(await applyOfferAndAttach(peer,{type:'offer'},null),[]);
  assert.deepEqual(events,['remote']);
});

test('colliding local offer is rolled back before applying incoming offer', async () => {
  const events=[];
  const peer={signalingState:'have-local-offer',async setLocalDescription(d){events.push(d.type)},async setRemoteDescription(d){events.push(d.type)},addTrack(){throw Error('duplicate track')}};
  await applyOfferAndAttach(peer,{type:'offer'},null);
  assert.deepEqual(events,['rollback','offer']);
});
