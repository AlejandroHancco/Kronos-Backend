# Tailscale on vm-worker

The worker runs with `network_mode: host`, so it uses the host's routes. Tailscale is installed
on the host (not in a container).

## Install

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --accept-routes
```

`--accept-routes` makes the host install the subnets advertised by the lab routers.

## One subnet router per lab

On a machine inside each lab network (any always-on Linux box):

```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale up --advertise-routes=<lab-subnet-cidr>   # e.g. 192.168.10.0/24
```

Then approve the advertised route in the Tailscale admin console (Machines -> Edit route
settings). Use non-overlapping CIDRs across labs.

## Verify from vm-worker

```bash
tailscale status
ip route | grep tailscale
ping <mux-ip-in-lab>
```
