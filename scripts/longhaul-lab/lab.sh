#!/bin/sh
# Long-haul lab: viewer (cli) -- point of presence (edge) -- origin (srv), shaped with netem.
# Usage, as root in WSL or Linux: sh lab.sh [segments]   (CCS="bbr" OUT=file.ndjson to narrow)
# See docs/global-delivery.md for the profiles and the results.
set -u
cd "$(dirname "$0")"
N=${1:-6}
OUT=${OUT:-results.ndjson}
: > $OUT

teardown() { pkill -f 'node serve.mjs' 2>/dev/null; for n in cli edge srv; do ip netns del $n 2>/dev/null; done; }
teardown
modprobe tcp_bbr; modprobe sch_netem
sysctl -qw net.core.rmem_max=16777216 net.core.wmem_max=16777216
for n in cli edge srv; do ip netns add $n; done
ip link add c0 netns cli type veth peer name e0 netns edge
ip link add e1 netns edge type veth peer name s0 netns srv
X() { ip netns exec "$@"; }
X cli ip addr add 10.0.1.2/24 dev c0; X edge ip addr add 10.0.1.1/24 dev e0
X edge ip addr add 10.0.2.1/24 dev e1; X srv ip addr add 10.0.2.2/24 dev s0
for p in "cli c0" "edge e0" "edge e1" "srv s0"; do set -- $p; X $1 ip link set $2 up; X $1 ip link set lo up; done
X cli ip route add default via 10.0.1.1; X srv ip route add default via 10.0.2.1
X edge sysctl -qw net.ipv4.ip_forward=1
for n in cli edge srv; do X $n sysctl -qw net.ipv4.tcp_rmem="4096 131072 16777216" net.ipv4.tcp_wmem="4096 65536 16777216" net.ipv4.tcp_slow_start_after_idle=0; done

X srv node serve.mjs 8080 >/dev/null 2>&1 &
sleep 1
# Fresh relay per run set: upstream keep-alive sockets keep the CC they were accepted with.
relay() { pkill -f 'serve.mjs 8081' 2>/dev/null; X edge node serve.mjs 8081 http://10.0.2.2:8080 >/dev/null 2>&1 & sleep 1; }

shape() {
  X edge tc qdisc replace dev e0 root netem delay ${2}ms loss ${3}% rate ${4} limit 100000
  X cli tc qdisc replace dev c0 root netem delay ${2}ms limit 100000
  X srv tc qdisc replace dev s0 root netem delay ${5}ms loss ${6}% limit 100000
  X edge tc qdisc replace dev e1 root netem delay ${5}ms limit 100000
}
run() {
  T=180; [ "$CC" = cubic ] && T=60
  r=$(timeout $T ip netns exec cli node client.mjs "$1" "$2" $N "$3" 2>/dev/null)
  [ -z "$r" ] && r="{\"mode\":\"$2\",\"timeout\":true,\"realtime\":0}"
  echo "{\"profile\":\"$P\",\"cc\":\"$CC\",\"path\":\"$4\",$(echo "$r" | cut -c2-)" | tee -a $OUT
}

#        name          lastMileDelay loss rate     longHaulDelay loss
for prof in "paris 2 0 200mbit 8 0" "seoul-fiber 2 0.02 200mbit 123 0.1" "seoul-4g 20 0.5 60mbit 105 0.1" "seoul-4g-bad 30 1.5 30mbit 95 0.2"; do
  set -- $prof; P=$1; shape $prof
  for CC in ${CCS:-cubic bbr}; do
    X srv sysctl -qw net.ipv4.tcp_congestion_control=$CC; X edge sysctl -qw net.ipv4.tcp_congestion_control=$CC
    relay
    run http://10.0.2.2:8080 seq d-$P-$CC direct
    run http://10.0.1.1:8081 seq r-$P-$CC edge-miss
    [ $CC = cubic ] && continue
    run http://10.0.2.2:8080 par4 d4-$P-$CC direct
    run http://10.0.2.2:8080 par8 d8-$P-$CC direct
    run http://10.0.1.1:8081 seq r-$P-$CC edge-hit
  done
done
teardown
