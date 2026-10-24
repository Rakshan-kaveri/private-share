/** Apply the incoming offer before attaching answerer media so matching recv-only transceivers can be reused. */
export async function applyOfferAndAttach(peer, description, stream) {
  if (peer.signalingState === 'have-local-offer') {
    await peer.setLocalDescription({type:'rollback'});
  }
  await peer.setRemoteDescription(description);
  return stream ? stream.getTracks().map(track => peer.addTrack(track, stream)) : [];
}
