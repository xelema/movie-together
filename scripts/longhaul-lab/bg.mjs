import http from 'node:http';

const [url, flows] = [process.argv[2], Number(process.argv[3] ?? 6)];
const agent = new http.Agent({ keepAlive: true, maxSockets: flows });
const loop = () => http.get(url + '/bg/' + Math.random(), { agent }, res => res.on('data', () => {}).on('end', loop)).on('error', () => setTimeout(loop, 500));
for (let i = 0; i < flows; i++) loop();
