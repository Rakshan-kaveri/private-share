# Deploying on Google Cloud (app + TURN on one VM)

Your VM: public IP `34.180.63.144`, private IP `10.160.0.2` (subnet in asia-south1, Mumbai).
Google Cloud maps the public IP onto the VM one-to-one. coturn has to know both addresses, so `.env` sets
`TURN_PUBLIC_IP=34.180.63.144/10.160.0.2`.

## 1. Copy the project to the VM and run the setup script

```bash
# from your PC (or upload the zip through the SSH window's "Upload file" button)
gcloud compute scp private-share-v6.zip private-share-file:~ --zone=YOUR_ZONE

# on the VM
sudo apt-get install -y unzip
unzip -o private-share-v6.zip
cd private-share-v6
bash deploy/gcp-setup.sh
```

The script:
- reads the VM's public and private IP from Google Cloud,
- writes them to `.env` and generates a TURN secret if there isn't a real one,
- stops your old v5 containers if they are holding port 8188,
- builds and starts the app, then starts coturn,
- checks both are running and prints the exact firewall commands for your VM.

## 2. Open the TURN ports in Google Cloud's firewall

The VM's firewall is managed by Google Cloud, not by the VM. Open **Cloud Shell** (the `>_` icon at the top of the
console) and run the two commands the script printed. They look like this:

```bash
gcloud compute instances add-tags private-share-file --tags=turn-server --zone=YOUR_ZONE

gcloud compute firewall-rules create allow-private-share-turn \
  --network=default --direction=INGRESS --action=ALLOW \
  --rules=udp:3478,tcp:3478,udp:49160-49200 \
  --source-ranges=0.0.0.0/0 --target-tags=turn-server
```

Console alternative: VPC network → Firewall → Create rule. Use target tag `turn-server`, source `0.0.0.0/0`,
UDP `3478,49160-49200` and TCP `3478`. Then add the network tag `turn-server` to the VM (Edit → Network tags).

## 3. Make the IP permanent

New VMs get an *ephemeral* IP, which changes if the VM is stopped. A changed IP breaks TURN until `.env` is updated.
Make it static once:

```bash
gcloud compute addresses create private-share-ip --addresses=34.180.63.144 --region=asia-south1
```

If the IP ever does change, run `bash deploy/gcp-setup.sh` again.

## 4. Check it

1. Open https://share.rakzu.xyz and sign in.
2. Click the lock icon at the top right, then **Check relay**. It should say *Relay works*.
3. Real test: phone on **mobile data (Wi-Fi off)** calls the PC. The call header shows *Direct connection* or
   *Relayed (still encrypted)*. Either is fine; relayed means TURN rescued the call.

## If "Check relay" fails

```bash
sudo docker compose ps                      # both app and coturn should be "Up"
sudo docker compose logs --tail=80 coturn   # look for errors about the secret or IP
sudo ss -lunp | grep 3478                   # coturn must be listening
gcloud compute firewall-rules list --filter="name~turn"   # (Cloud Shell) rule exists
```

Most common causes: the network tag isn't on the VM, the rule was created on a different network, or `.env` still has an
old IP. Some college/office Wi-Fi blocks every port except 443. Those networks need TURN over TLS on 443, which needs a
certificate and isn't set up here.

## Cost note

Direct calls cost nothing extra. Relayed calls send media out of Google Cloud, which is billed as internet egress
(roughly ₹8–10 per GB from Mumbai; check current pricing). A relayed video call uses about 1–1.5 GB per hour. coturn is
capped at 4 Mbps per session and 200 sessions total, so one runaway client can't run up a bill. Set a budget alert in
Billing → Budgets & alerts.

## Useful commands

```bash
sudo docker compose up -d --build app            # after changing app files
sudo docker compose --profile turn up -d coturn  # after changing TURN settings
sudo docker compose restart app                  # after editing .env (app settings)
sudo docker compose logs -f app                  # live app log
```
