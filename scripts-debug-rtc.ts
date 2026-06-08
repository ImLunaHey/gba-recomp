import { Rtc } from '../../src/memory/rtc';
const rtc = new Rtc();
function en() {
  rtc.write(0xC8, 1);
  rtc.write(0xC6, 0x05);
  rtc.write(0xC4, 0);
  rtc.write(0xC4, 0x04);
}
function cmd(b: number) {
  rtc.write(0xC6, 0x07);
  for (let i = 0; i < 8; i++) {
    const bit = (b >> (7 - i)) & 1;
    rtc.write(0xC4, 0x04 | (bit << 1));
    rtc.write(0xC4, 0x04 | (bit << 1) | 1);
  }
}
function data(b: number) {
  rtc.write(0xC6, 0x07);
  for (let i = 0; i < 8; i++) {
    const bit = (b >> i) & 1;
    rtc.write(0xC4, 0x04 | (bit << 1));
    rtc.write(0xC4, 0x04 | (bit << 1) | 1);
  }
}
en(); cmd(0x62); console.log(`after cmd62: cmd=${rtc.cmd.toString(16)} state=${rtc.state} payloadLen=${rtc.payloadLen}`);
data(0x42); console.log(`after data42: status=${rtc.status.toString(16)}`);
rtc.write(0xC4, 0); console.log(`after end1: state=${rtc.state} status=${rtc.status.toString(16)}`);
en(); console.log(`after en2: state=${rtc.state} status=${rtc.status.toString(16)}`);
cmd(0x63); console.log(`after cmd63: state=${rtc.state} status=${rtc.status.toString(16)} payload=[${rtc.payload.map(p=>p.toString(16)).join(',')}]`);
