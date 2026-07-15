import { double } from "./math.js";

export function run(value: number) {
  return double(value) + 1;
}

console.log(run(20));
