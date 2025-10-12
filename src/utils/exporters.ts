import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, convertInchesToTwip, ImageRun } from "docx";
import type { ArticleData, ExportFormat } from "../types/index";
import { articleToMarkdown, articleToPlainText } from "./extractor";

interface ExportPayload {
  format: ExportFormat;
  blob: Blob;
  fileName: string;
}

interface BuildExportOptions {
  baseFileName: string;
}

export async function buildExportPayloads(
  article: ArticleData,
  formats: ExportFormat[],
  options: BuildExportOptions
): Promise<ExportPayload[]> {
  const payloads: ExportPayload[] = [];
  const uniqueFormats = Array.from(new Set(formats));

  for (const format of uniqueFormats) {
    switch (format) {
      case "markdown":
        payloads.push({
          format,
          fileName: `${options.baseFileName}.md`,
          blob: new Blob([
            articleToMarkdown(article)
          ], { type: "text/markdown;charset=utf-8" })
        });
        break;
      case "text":
        payloads.push({
          format,
          fileName: `${options.baseFileName}.txt`,
          blob: new Blob([articleToPlainText(article)], {
            type: "text/plain;charset=utf-8"
          })
        });
        break;
      case "word": {
        const docxBlob = await buildDocx(article);
        payloads.push({
          format,
          fileName: `${options.baseFileName}.docx`,
          blob: docxBlob
        });
        break;
      }
      case "pdf": {
        const pdfBlob = await buildPdf(article);
        payloads.push({
          format,
          fileName: `${options.baseFileName}.pdf`,
          blob: pdfBlob
        });
        break;
      }
      default:
        console.warn("Unsupported format", format);
    }
  }

  return payloads;
}

async function buildDocx(article: ArticleData): Promise<Blob> {
  // 创建文档
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1), // 2.54cm
            bottom: convertInchesToTwip(0.8), // 2cm  
            left: convertInchesToTwip(0.8), // 2cm
            right: convertInchesToTwip(0.8), // 2cm
          },
        },
      },
      children: await parseContentToDocx(article),
    }],
  });

  // 生成DOCX文件 - 使用浏览器兼容的方式
  const buffer = await Packer.toBlob(doc);
  return buffer;
}

async function parseContentToDocx(article: ArticleData): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  
  // 添加标题
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: article.title,
          bold: true,
          size: 32, // 16pt (size is in half-points)
          font: "Times New Roman",
        }),
      ],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: {
        after: 480, // 24pt after
      },
    })
  );

  // 添加作者信息（如果有）
  if (article.byline) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `作者：${article.byline}`,
            italics: true,
            size: 22, // 11pt
            font: "Times New Roman",
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          after: 240, // 12pt after
        },
      })
    );
  }

  // 解析HTML内容
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = article.contentHtml;
  
  // 遍历DOM节点并转换为Word段落
  const processNode = async (node: Node): Promise<void> => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: text,
                size: 24, // 12pt
                font: "Times New Roman",
              }),
            ],
            spacing: {
              before: 120, // 6pt before
              after: 120,  // 6pt after
              line: 360,   // 1.5 line spacing (240 = single, 360 = 1.5, 480 = double)
            },
            indent: {
              firstLine: convertInchesToTwip(0.5), // 首行缩进0.5英寸
            },
          })
        );
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      
      switch (element.tagName.toLowerCase()) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          const headingLevel = parseInt(element.tagName.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
          const headingSize = Math.max(28 - (headingLevel - 1) * 2, 24); // 从14pt递减到12pt
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: element.textContent || '',
                  bold: true,
                  size: headingSize,
                  font: "Times New Roman",
                }),
              ],
              heading: headingLevel <= 3 ? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][headingLevel - 1] : undefined,
              spacing: {
                before: 240, // 12pt before
                after: 120,  // 6pt after
              },
            })
          );
          break;
          
        case 'p':
          const pText = element.textContent?.trim();
          if (pText) {
            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: pText,
                    size: 24, // 12pt
                    font: "Times New Roman",
                  }),
                ],
                spacing: {
                  before: 120, // 6pt before
                  after: 120,  // 6pt after
                  line: 360,   // 1.5 line spacing
                },
                indent: {
                  firstLine: convertInchesToTwip(0.5), // 首行缩进
                },
              })
            );
          }
          break;
          
        case 'img':
          const imgElement = element as HTMLImageElement;
          const imgSrc = imgElement.src;
          
          try {
            // 尝试下载并嵌入图片
            const response = await fetch(imgSrc);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const uint8Array = new Uint8Array(arrayBuffer);
              
              // 获取图片类型
              const contentType = response.headers.get('content-type') || '';
              let imageType = 'jpg'; // 默认
              if (contentType.includes('png')) {
                imageType = 'png';
              } else if (contentType.includes('gif')) {
                imageType = 'gif';
              }
              
              // 嵌入图片
              paragraphs.push(
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: uint8Array,
                      transformation: {
                        width: 400, // 限制宽度
                        height: 300, // 限制高度
                      },
                      type: "jpg", // 指定图片类型
                    })
                  ],
                  alignment: AlignmentType.CENTER,
                  spacing: {
                    before: 120,
                    after: 120,
                  },
                })
              );
              
              // 如果有 alt 文本，添加图片说明
              if (imgElement.alt) {
                paragraphs.push(
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: imgElement.alt,
                        italics: true,
                        size: 20, // 10pt
                        font: "Times New Roman",
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                    spacing: {
                      after: 120,
                    },
                  })
                );
              }
            } else {
              throw new Error(`Failed to fetch image: ${response.status}`);
            }
          } catch (error) {
            console.warn('Failed to embed image:', imgSrc, error);
            // 如果图片下载失败，使用占位符
            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `[图片无法加载: ${imgElement.alt || imgSrc}]`,
                    italics: true,
                    size: 22, // 11pt
                    font: "Times New Roman",
                  }),
                ],
                alignment: AlignmentType.CENTER,
                spacing: {
                  before: 120,
                  after: 120,
                },
              })
            );
          }
          break;
          
        case 'blockquote':
          const quoteText = element.textContent?.trim();
          if (quoteText) {
            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: quoteText,
                    italics: true,
                    size: 22, // 11pt
                    font: "Times New Roman",
                  }),
                ],
                spacing: {
                  before: 120,
                  after: 120,
                  line: 360,
                },
                indent: {
                  left: convertInchesToTwip(0.5), // 左缩进
                  right: convertInchesToTwip(0.5), // 右缩进
                },
              })
            );
          }
          break;
          
        case 'li':
          const liText = element.textContent?.trim();
          if (liText) {
            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `• ${liText}`,
                    size: 24, // 12pt
                    font: "Times New Roman",
                  }),
                ],
                spacing: {
                  before: 60,
                  after: 60,
                  line: 360,
                },
                indent: {
                  left: convertInchesToTwip(0.25), // 列表缩进
                },
              })
            );
          }
          break;
          
        default:
          // 递归处理子节点
          for (const child of Array.from(element.childNodes)) {
            await processNode(child);
          }
          break;
      }
    }
  };

  // 处理所有子节点
  for (const child of Array.from(tempDiv.childNodes)) {
    await processNode(child);
  }

  return paragraphs;
}

async function buildPdf(article: ArticleData): Promise<Blob> {
  const pdf = await PDFDocument.create();
  
  // 使用支持中文的字体 - Times Roman 对中文支持更好
  // 或者可以考虑嵌入中文字体文件
  let font, bold;
  try {
    // 尝试使用 Times Roman，它对 Unicode 字符支持更好
    font = await pdf.embedFont(StandardFonts.TimesRoman);
    bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  } catch (error) {
    // 如果失败，回退到基础字体，但需要过滤掉不支持的字符
    console.warn("无法嵌入 Times Roman 字体，使用 Helvetica 替代:", error);
    font = await pdf.embedFont(StandardFonts.Helvetica);
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }
  
  const margin = 48;

  let page = pdf.addPage();
  let { width, height } = page.getSize();
  let cursorY = height - margin;

  const ensureCursor = (lineHeight: number, fontSize: number) => {
    if (cursorY <= margin) {
      page = pdf.addPage();
      ({ width, height } = page.getSize());
      cursorY = height - margin;
    }
  };

  // 检查字体是否支持特定字符
  const canEncodeText = (text: string, targetFont: any): boolean => {
    try {
      targetFont.encodeText(text);
      return true;
    } catch (error) {
      return false;
    }
  };

  // 过滤或替换不支持的字符
  const sanitizeText = (text: string, targetFont: any): string => {
    if (canEncodeText(text, targetFont)) {
      return text;
    }

    // 如果整个文本不能编码，尝试逐字符检查并替换
    let result = '';
    for (const char of text) {
      if (canEncodeText(char, targetFont)) {
        result += char;
      } else {
        // 对于不支持的字符，用问号替代或跳过
        result += '?';
      }
    }
    return result;
  };

  const drawText = (
    text: string,
    options: { fontSize?: number; lineHeight?: number; bold?: boolean } = {}
  ) => {
    const fontSize = options.fontSize ?? 12;
    const lineHeight = options.lineHeight ?? 1.4;
    const activeFont = options.bold ? bold : font;
    
    // 清理文本，确保字体支持
    const cleanText = sanitizeText(text, activeFont);
    const words = cleanText.split(/\s+/);
    let line = "";

    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      const textWidth = activeFont.widthOfTextAtSize(testLine, fontSize);
      if (textWidth > width - margin * 2 && line) {
        ensureCursor(lineHeight, fontSize);
        page.drawText(line, {
          x: margin,
          y: cursorY,
          size: fontSize,
          font: activeFont,
          color: rgb(0.1, 0.1, 0.1)
        });
        cursorY -= fontSize * lineHeight;
        line = word;
      } else {
        line = testLine;
      }
    }

    if (line) {
      ensureCursor(lineHeight, fontSize);
      page.drawText(line, {
        x: margin,
        y: cursorY,
        size: fontSize,
        font: activeFont,
        color: rgb(0.1, 0.1, 0.1)
      });
      cursorY -= fontSize * lineHeight;
    }
  };

  drawText(article.title, { fontSize: 18, lineHeight: 1.6, bold: true });
  cursorY -= 6;
  if (article.byline) {
    drawText(article.byline, { fontSize: 12, lineHeight: 1.4 });
  }
  cursorY -= 10;

  const paragraphs = article.textContent.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    drawText(trimmed, { fontSize: 12 });
    cursorY -= 8;
  }

  if (article.images.length) {
    cursorY -= 12;
  }

  for (const [index, image] of article.images.entries()) {
    try {
      const response = await fetch(image.url);
      if (!response.ok) continue;
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "";

      let embedded;
      const lowerUrl = image.url.toLowerCase();
      if (contentType.includes("png") || lowerUrl.endsWith(".png")) {
        embedded = await pdf.embedPng(arrayBuffer);
      } else {
        embedded = await pdf.embedJpg(arrayBuffer);
      }

      const imageWidth = embedded.width;
      const imageHeight = embedded.height;
      const maxWidth = width - margin * 2;
      const maxHeight = height - margin * 2;
      const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
      const drawWidth = imageWidth * scale;
      const drawHeight = imageHeight * scale;

      if (cursorY - drawHeight < margin) {
        page = pdf.addPage();
        ({ width, height } = page.getSize());
        cursorY = height - margin;
      }

      page.drawImage(embedded, {
        x: margin,
        y: cursorY - drawHeight,
        width: drawWidth,
        height: drawHeight
      });
      cursorY -= drawHeight + 12;

      if (image.alt) {
        drawText(`图 ${index + 1}: ${image.alt}`, {
          fontSize: 11,
          lineHeight: 1.3
        });
        cursorY -= 6;
      }
    } catch (error) {
      console.warn("图片写入 PDF 失败", image.url, error);
    }
  }

  const pdfBytes = await pdf.save();
  return new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
}
