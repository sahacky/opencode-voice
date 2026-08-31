import { describe, expect, test } from "bun:test"
import { cleanText } from "../src/index"

describe("cleanText", () => {
    test("схлопывает пробелы, капитализирует, ставит точку", () => {
        expect(cleanText("  привет   мир  ")).toBe("Привет мир.")
    })

    test("убирает слова-паразиты", () => {
        expect(cleanText("ээ короче говоря сделай эм задачу")).toBe("Сделай задачу.")
    })

    test("вырезает невербальные блоки отдельными строками", () => {
        expect(cleanText("[музыка]\nтекст\n(шум)")).toBe("Текст.")
    })

    test("«новая строка» превращается в перевод строки", () => {
        expect(cleanText("привет новая строка мир")).toBe("Привет.\nМир.")
    })

    test("звёздочки вырезаются", () => {
        expect(cleanText("*первое* второе")).toBe("Первое второе.")
    })

    test("не дублирует конечную пунктуацию", () => {
        expect(cleanText("как дела?")).toBe("Как дела?")
        expect(cleanText("вот так:")).toBe("Вот так:")
    })

    test("пустой ввод", () => {
        expect(cleanText("")).toBe("")
        expect(cleanText("   ")).toBe("")
    })
})
