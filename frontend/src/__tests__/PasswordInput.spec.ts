import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PasswordInput from '@/components/PasswordInput.vue'

describe('PasswordInput', () => {
  it('masks by default and reveals the typed value on toggle', async () => {
    const wrapper = mount(PasswordInput, { props: { id: 'pw', modelValue: 'secret' } })
    const input = wrapper.get('input')
    const toggle = wrapper.get('button')

    expect(input.attributes('type')).toBe('password')
    expect(toggle.attributes('aria-label')).toBe('Show password')
    expect(toggle.attributes('aria-pressed')).toBe('false')

    await toggle.trigger('click')
    expect(input.attributes('type')).toBe('text')
    expect(toggle.attributes('aria-label')).toBe('Hide password')
    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(input.attributes('autocomplete')).toBe('current-password')
  })
})
