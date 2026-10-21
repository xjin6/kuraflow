# Source: notofonts/noto-cjk, Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf
# License: SIL OFL 1.1. Requires fonttools; font family renamed for this derivative.
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
import argparse
parser=argparse.ArgumentParser(description='Convert the licensed Noto Serif CJK SC font to PDF-compatible TrueType.')
parser.add_argument('--source',required=True);parser.add_argument('--output',required=True)
args=parser.parse_args()
f=TTFont(args.source)
source_names={key:f['name'].getDebugName(key) for key in [0,13,14]}
options=subset.Options();options.layout_features=[];options.hinting=False
sub=subset.Subsetter(options=options);sub.populate(unicodes=f.getBestCmap().keys());sub.subset(f)
order=f.getGlyphOrder();glyphset=f.getGlyphSet();glyphs={}
for name in order:
 p=TTGlyphPen(glyphset);q=Cu2QuPen(p,1,reverse_direction=True);glyphset[name].draw(q);glyphs[name]=p.glyph()
b=FontBuilder(f['head'].unitsPerEm,isTTF=True);b.setupGlyphOrder(order);b.setupCharacterMap(f.getBestCmap());b.setupGlyf(glyphs);b.setupHorizontalMetrics(f['hmtx'].metrics)
b.setupHorizontalHeader(ascent=f['hhea'].ascent,descent=f['hhea'].descent,lineGap=f['hhea'].lineGap)
names={'familyName':'Kuraflow Document Serif','styleName':'Regular','uniqueFontIdentifier':'KuraflowDocumentSerif-Regular','fullName':'Kuraflow Document Serif Regular','psName':'KuraflowDocumentSerif-Regular','version':'Version 1.0','copyright':'Copyright 2017 Adobe (http://www.adobe.com/), with Reserved Font Name Source. Licensed under the SIL Open Font License 1.1; converted from Noto Serif CJK SC.'}
names['copyright']=source_names[0] or names['copyright']
b.setupNameTable(names);
for key in [13,14]:
 if source_names[key]: b.font['name'].setName(source_names[key],key,3,1,0x409)
b.setupOS2(sTypoAscender=f['OS/2'].sTypoAscender,sTypoDescender=f['OS/2'].sTypoDescender,sTypoLineGap=f['OS/2'].sTypoLineGap,usWinAscent=f['OS/2'].usWinAscent,usWinDescent=f['OS/2'].usWinDescent);b.setupPost();b.setupMaxp();b.save(args.output)
print('Converted',len(order),'glyphs; all source Unicode mappings preserved.')
