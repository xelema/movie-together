#!/bin/sh
# Congested international link: 100 Mbit/s shared bottleneck on the long haul,
# 6 competing CUBIC flows (other users), 4G last mile. Run as root in WSL.
set -u
cd "$(dirname "$0")"
N=${1:-6}
OUT=results2.ndjson
: > $OUT
X() { ip netns exec "$@"; }
teardown() { pkill -f 'node serve.mjs' 2>/dev/null; pkill -f 'node bg.mjs' 2>/dev/null; for n in cli edge srv; do ip netns del $n 2>/dev/null; done; }
teardown
modprobe tcp_bbr; modprobe sch_netem
for n in cli edge srv; do ip netns add $n; done
ip link add c0 netns cli type veth peer name e0 netns edge
ip link add e1 netns edge type veth peer name s0 netns srv
X cli ip addr add 10.0.1.2/24 dev c0; X edge ip addr add 10.0.1.1/24 dev e0
X edge ip addr add 10.0.2.1/24 dev e1; X srv ip addr add 10.0.2.2/24 dev s0
for p in "cli c0" "edge e0" "edge e1" "srv s0"; do set -- $p; X $1 ip link set $2 up; X $1 ip link set lo up; done
X cli ip route add default via 10.0.1.1; X srv ip route add default via 10.0.2.1
X edge sysctl -qw net.ipv4.ip_forward=1
for n in cli edge srv; do X $n sysctl -qw net.ipv4.tcp_rmem="4096 131072 16777216" net.ipv4.tcp_wmem="4096 65536 16777216" net.ipv4.tcp_slow_start_after_idle=0; done

X edge tc qdisc replace dev e0 root netem delay 20ms loss 0.3% rate 60mbit limit 100000
X cli tc qdisc replace dev c0 root netem delay 20ms limit 100000
X srv tc qdisc replace dev s0 root netem delay 105ms rate 100mbit limit 1500
X edge tc qdisc replace dev e1 root netem delay 105ms limit 100000

# Accepted sockets take the namespace default CC at accept time: the background
# flows connect while it is cubic and keep their sockets alive.
X edge sysctl -qw net.ipv4.tcp_congestion_control=bbr
X srv sysctl -qw net.ipv4.tcp_congestion_control=cubic
X srv node serve.mjs 8080 >/dev/null 2>&1 &
X edge node serve.mjs 8081 http://10.0.2.2:8080 >/dev/null 2>&1 &
sleep 1
X edge node bg.mjs http://10.0.2.2:8080 6 >/dev/null 2>&1 &
sleep 15

P=seoul-congested
run() {
  X srv sysctl -qw net.ipv4.tcp_congestion_control=$4
  r=$(timeout 150 ip netns exec cli node client.mjs "$1" "$2" $N "$3" 2>/dev/null)
  [ -z "$r" ] && r="{\"mode\":\"$2\",\"timeout\":true,\"realtime\":0}"
  echo "{\"profile\":\"$P\",\"cc\":\"$4\",\"path\":\"$5\",$(echo "$r" | cut -c2-)" | tee -a $OUT
}
run http://10.0.2.2:8080 seq c-seq cubic direct
for m in seq par4 par8; do run http://10.0.2.2:8080 $m b-$m bbr direct; done
run http://10.0.1.1:8081 seq r bbr edge-miss
run http://10.0.1.1:8081 seq r bbr edge-hit
teardown
