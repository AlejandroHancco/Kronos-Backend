import { estimateSeconds } from './estimate';

// Expected values computed from the original MeasurementSchedulingService formula:
// ceil(channels * (1.5 + sum(1 + points * 0.01)))
describe('estimateSeconds', () => {
  it('one range of 10 points, 1 channel => ceil(1 * (1.5 + 1 + 0.1)) = 3', () => {
    expect(estimateSeconds([{ points: 10 }], 1)).toBe(3);
  });

  it('ranges of 100 and 801 points, 3 channels => ceil(3 * (1.5 + 2 + 9.01)) = 38', () => {
    expect(estimateSeconds([{ points: 100 }, { points: 801 }], 3)).toBe(38);
  });
});
