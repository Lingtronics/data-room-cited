# Approved synthetic voice fixture v1

All names and events in these three text files are authored demonstration data.
No customer documents, extracted private text or third-party material are included.
The malicious sentence in the 2024 notes is a prompt-injection test **datum**.

`manifest.json` pins exact source/index bytes and sizes. Runtime code reads this
trusted repository manifest; clients cannot select or supply a different manifest.
`.gitattributes` preserves these bytes on Windows checkouts. Changing the approved
fixture requires a reviewed source/index/manifest update, not a runtime flag.

The index uses the existing Chunk schema and zero NumPy embeddings for deterministic
**lexical retrieval only**. No semantic embedding model is downloaded. The internal
Chunk page=1 is a schema placeholder for the single text section; it is not a PDF
page citation. Voice responses return page_label=null and the authored section title.

Run `python scripts/prepare_voice_fixture.py --destination .voice-demo` once to
create separate copies. Existing destinations are refused. Do not run the ordinary
index builder on this fixture or add other files to its data/index directories.
