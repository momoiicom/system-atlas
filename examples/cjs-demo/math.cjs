exports.double = function double(value) {
  return value * 2;
};

exports.Calculator = class Calculator {
  increment(value) {
    return exports.double(value) + 1;
  }
};
