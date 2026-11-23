import { describe, it, expect } from 'vitest';
import PizZip from 'pizzip';
import { makeDocx, para, run, textOf, xmlOf } from './helpers/docx.js';
import { DocxTemplateError, fillTemplate, findBlanks, formatDateOrdinal, formatValue, isZip } from '../src/modules/review/docxTemplate.js';

const FONT = '<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:sz w:val="20"/>';

describe('finding the blanks of a Word template', () => {
  it('finds a blank in one run', () => {
    expect(findBlanks(makeDocx(para(run('made on this {{start_date}} by')))) ).toEqual(['start_date']);
  });

  it('finds a blank that Word split over several runs', () => {
    const d = makeDocx(para(run('between '), run('{{coun', FONT), run('terparty_', '<w:b/>'), run('name}}, a company')));
    expect(findBlanks(d)).toEqual(['counterparty_name']);
  });

  it('finds blanks in the header and the footer too, once each, in the order first seen', () => {
    const d = makeDocx(para(run('{{b_one}} and {{a_two}} and {{b_one}}')), {
      'word/header1.xml': `<w:hdr xmlns:w="x">${para(run('For {{header_name}}'))}</w:hdr>`,
      'word/footer1.xml': `<w:ftr xmlns:w="x">${para(run('{{footer_note}}'))}</w:ftr>`,
    });
    expect(findBlanks(d)).toEqual(['b_one', 'a_two', 'header_name', 'footer_note']);
  });

  it('allows spaces inside the braces, and ignores text that only looks like a blank', () => {
    const d = makeDocx(para(run('{{ spaced_name }} {{Capital}} {{9digit}} {single} {{ }}')));
    expect(findBlanks(d)).toEqual(['spaced_name']);
  });

  it('has no blanks in a plain agreement', () => {
    expect(findBlanks(makeDocx(para(run('Nothing to fill here.'))))).toEqual([]);
  });
});

describe('filling the blanks', () => {
  it('replaces the blank and leaves every other word exactly as it was', () => {
    const d = makeDocx(para(run('This agreement is made on '), run('{{start_date}}', FONT), run(', by and between us.')));
    const out = fillTemplate(d, { start_date: '19th of March, 2026' });
    expect(textOf(out)).toBe('This agreement is made on 19th of March, 2026, by and between us.');
    expect(xmlOf(out)).not.toContain('{{');
  });

  it('keeps the font and size of the run the blank was in (the new words look like the rest of the sentence)', () => {
    const d = makeDocx(para(run('Name: '), run('{{signer_name}}', `${FONT}<w:b/>`)));
    const out = fillTemplate(d, { signer_name: 'Joseph Kumar' });
    const xml = xmlOf(out);
    expect(xml).toContain('Joseph Kumar');
    // the run holding the name still carries Cambria, the size and bold
    const holder = xml.match(/<w:r>(?:(?!<\/w:r>).)*Joseph Kumar(?:(?!<\/w:r>).)*<\/w:r>/s)![0];
    expect(holder).toContain('w:ascii="Cambria"');
    expect(holder).toContain('<w:sz w:val="20"/>');
    expect(holder).toContain('<w:b/>');
  });

  it('fills a blank that was split over several runs', () => {
    const d = makeDocx(para(run('between '), run('{{coun', FONT), run('terparty_', FONT), run('name}}, a company')));
    expect(textOf(fillTemplate(d, { counterparty_name: 'Sample Private Limited' }))).toBe('between Sample Private Limited, a company');
  });

  it('fills the same blank everywhere it appears, including the header and the footer', () => {
    const d = makeDocx(para(run('Intro: {{company}}. Signing block: For {{company}}')), {
      'word/header1.xml': `<w:hdr xmlns:w="x">${para(run('{{company}} | Confidential'))}</w:hdr>`,
    });
    const out = fillTemplate(d, { company: 'Acme Corp' });
    expect(textOf(out)).toBe('Intro: Acme Corp. Signing block: For Acme Corp');
    expect(textOf(out, 'word/header1.xml')).toBe('Acme Corp | Confidential');
  });

  it('writes special characters safely (an ampersand or a bracket cannot break the Word file)', () => {
    const d = makeDocx(para(run('{{company}}')));
    const out = fillTemplate(d, { company: 'Smith & Sons <Pvt> "Ltd"' });
    expect(xmlOf(out)).toContain('Smith &amp; Sons &lt;Pvt&gt;');
    // it still opens as a Word file and reads back the same text
    expect(new PizZip(out).file('word/document.xml')).not.toBeNull();
  });

  it('refuses when a blank has no value, naming it, instead of leaving "{{...}}" in an agreement', () => {
    const d = makeDocx(para(run('{{a_name}} and {{b_date}}')));
    expect(() => fillTemplate(d, { a_name: 'X' })).toThrow(/needs a value for: b_date/);
    expect(() => fillTemplate(d, { a_name: 'X', b_date: '   ' })).toThrow(/b_date/);
  });

  it('ignores a value for a blank the template does not have', () => {
    const d = makeDocx(para(run('{{a_name}}')));
    expect(textOf(fillTemplate(d, { a_name: 'X', not_in_file: 'Y' }))).toBe('X');
  });

  it('removes control characters and text-direction tricks from a value', () => {
    const d = makeDocx(para(run('{{a_name}}')));
    expect(textOf(fillTemplate(d, { a_name: 'Jo\u0000hn‮ Smith\u0007' }))).toBe('John Smith');
  });

  it('does not change the Word file it was given', () => {
    const d = makeDocx(para(run('{{a_name}}')));
    const copy = Buffer.from(d);
    fillTemplate(d, { a_name: 'X' });
    expect(d.equals(copy)).toBe(true);
  });
});

describe('files that are not a safe Word template', () => {
  it('refuses a file that is not a Word file', () => {
    expect(() => findBlanks(Buffer.from('%PDF-1.7 not a docx'))).toThrow(DocxTemplateError);
    expect(() => fillTemplate(Buffer.from('hello world, plain text'), {})).toThrow(/not a Word/);
    expect(isZip(Buffer.from('%PDF'))).toBe(false);
  });

  it('refuses a zip that is not a Word file', () => {
    const zip = new PizZip();
    zip.file('readme.txt', 'hi');
    expect(() => findBlanks(zip.generate({ type: 'nodebuffer' }) as Buffer)).toThrow(/not a Word/);
  });

  it('refuses a Word file with macros', () => {
    const d = makeDocx(para(run('x')), { 'word/vbaProject.bin': 'macro bytes' });
    expect(() => findBlanks(d)).toThrow(/macros/);
  });

  it('refuses a damaged file', () => {
    const d = makeDocx(para(run('x')));
    const broken = Buffer.concat([d.subarray(0, 30), Buffer.alloc(40, 7)]);
    expect(() => findBlanks(broken)).toThrow(DocxTemplateError);
  });

  it('refuses a zip bomb (tiny file, huge when unpacked)', () => {
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document><w:body/></w:document>');
    zip.file('word/huge.bin', Buffer.alloc(90 * 1024 * 1024, 0));
    const bomb = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
    expect(bomb.length).toBeLessThan(1_000_000);
    expect(() => findBlanks(bomb)).toThrow(/too large when unpacked/);
  });
});

describe('tidying what the client typed', () => {
  it('names: capital letters, one space, hyphens and apostrophes handled', () => {
    expect(formatValue('joseph', 'name')).toBe('Joseph');
    expect(formatValue('  joseph   KUMAR ', 'name')).toBe('Joseph Kumar');
    expect(formatValue("o'brien-smith", 'name')).toBe("O'Brien-Smith");
    expect(formatValue('mary ann d. souza', 'name')).toBe('Mary Ann D. Souza');
  });

  it('leaves a word that already has its own capitals as typed (McDonald, DeCircle)', () => {
    expect(formatValue('ronald mcDonald', 'name')).toBe('Ronald McDonald');
    expect(formatValue('decircle Solar', 'title')).toBe('Decircle Solar');
    expect(formatValue('DeCircle solar', 'title')).toBe('DeCircle Solar');
  });

  it('titles: small joining words stay lower case, but not the first word', () => {
    expect(formatValue('bank of baroda', 'title')).toBe('Bank of Baroda');
    expect(formatValue('the sample company', 'title')).toBe('The Sample Company');
    expect(formatValue('sample pvt ltd', 'title')).toBe('Sample Pvt Ltd');
  });

  it('keeps legal and job abbreviations in capitals', () => {
    expect(formatValue('acme llp', 'title')).toBe('Acme LLP');
    expect(formatValue('ceo', 'title')).toBe('CEO');
    expect(formatValue('co-founder & ceo', 'title')).toBe('Co-Founder & CEO');
  });

  it('upper case, and "none" only trims', () => {
    expect(formatValue(' mumbai ', 'upper')).toBe('MUMBAI');
    expect(formatValue('  keep   as   typed ', 'none')).toBe('keep as typed');
    expect(formatValue('  keep   as   typed ', undefined)).toBe('keep as typed');
  });

  it('dates: the ordinal form used in the agreement', () => {
    expect(formatDateOrdinal('2026-03-19')).toBe('19th of March, 2026');
    expect(formatDateOrdinal('19/03/2026')).toBe('19th of March, 2026');
    expect(formatDateOrdinal('19-03-2026')).toBe('19th of March, 2026');
    expect(formatDateOrdinal('19 March 2026')).toBe('19th of March, 2026');
    expect(formatDateOrdinal('19th of Mar, 2026')).toBe('19th of March, 2026');
    expect(formatValue('2026-01-01', 'date_ordinal')).toBe('1st of January, 2026');
    expect(formatValue('2026-02-02', 'date_ordinal')).toBe('2nd of February, 2026');
    expect(formatValue('2026-04-03', 'date_ordinal')).toBe('3rd of April, 2026');
    for (const [d, o] of [['11', '11th'], ['12', '12th'], ['13', '13th'], ['21', '21st'], ['22', '22nd'], ['23', '23rd'], ['30', '30th']] as const) {
      expect(formatDateOrdinal(`2026-05-${d}`)).toBe(`${o} of May, 2026`);
    }
  });

  it('dates that are not real, or not a date, are left as typed', () => {
    expect(formatDateOrdinal('31/02/2026')).toBe('31/02/2026');
    expect(formatDateOrdinal('2026-13-01')).toBe('2026-13-01');
    expect(formatDateOrdinal('next monday')).toBe('next monday');
    expect(formatDateOrdinal('32 March 2026')).toBe('32 March 2026');
  });
});
