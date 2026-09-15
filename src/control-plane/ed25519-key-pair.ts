const keyPairProbe = new TextEncoder().encode("diaoyan-ed25519-key-pair-check-v1");

export async function assertEd25519KeyPair(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  name: string,
): Promise<void> {
  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign("Ed25519", privateKey, keyPairProbe);
  } catch (error) {
    throw new Error(`${name} private key could not sign the key-pair probe.`, { cause: error });
  }

  let verified: boolean;
  try {
    verified = await crypto.subtle.verify("Ed25519", publicKey, signature, keyPairProbe);
  } catch (error) {
    throw new Error(`${name} public key could not verify the key-pair probe.`, { cause: error });
  }
  if (!verified) throw new Error(`${name} private and public keys do not match.`);
}
