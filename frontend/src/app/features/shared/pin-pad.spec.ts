import { TestBed } from '@angular/core/testing';
import { PinPad } from './pin-pad';

describe('the PIN pad', () => {
  function render() {
    const fixture = TestBed.createComponent(PinPad);
    const entered: string[] = [];
    fixture.componentInstance.entered.subscribe((pin) => entered.push(pin));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const tap = (label: string) => {
      el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
      fixture.detectChanges();
    };
    const lit = () => el.querySelectorAll('.dot.on').length;
    return { fixture, el, entered, tap, lit };
  }

  it('fills a dot a digit, and sends the PIN with the fourth', () => {
    const { entered, tap, lit } = render();

    tap('Digit 1');
    tap('Digit 9');
    expect(lit()).toBe(2);
    tap('Delete a digit');
    expect(lit()).toBe(1);
    tap('Digit 2');
    tap('Digit 0');
    expect(entered).toEqual([]);
    tap('Digit 7');

    expect(entered).toEqual(['1207']);
  });

  it('takes the digits from the keyboard too', () => {
    const { entered, fixture } = render();

    for (const key of ['4', '3', '2', '1']) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    fixture.detectChanges();

    expect(entered).toEqual(['4321']);
  });

  it('says a wrong one, and empties for the next', async () => {
    const { fixture, el, tap, lit } = render();
    tap('Digit 5');
    fixture.componentRef.setInput('error', 'That PIN is not right.');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('.error')!.textContent).toBe('That PIN is not right.');
    expect(lit()).toBe(0);
  });
});
