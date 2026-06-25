//! Minimal ZIP archive writer, hand-rolled because the `zip` crate's default
//! features don't all build on `wasm32-unknown-unknown`. Entries are deflated
//! with `flate2` (already a dependency) and its `Crc` for the per-entry CRC-32.

use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};

// PKZIP magic numbers (little-endian on the wire).
const LOCAL_FILE_HEADER: u32 = 0x0403_4b50;
const CENTRAL_DIR_HEADER: u32 = 0x0201_4b50;
const END_OF_CENTRAL_DIR: u32 = 0x0605_4b50;

// Method 8 = DEFLATE; version 20 = the minimum that supports it.
const METHOD_DEFLATE: u16 = 8;
const VERSION_DEFLATE: u16 = 20;

// MS-DOS time/date pinned to 1980-01-01 (the format's epoch) for reproducible
// archives, since a zero date is invalid. 0x0021 == (year 0 << 9) | (1 << 5) | 1.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;

struct Entry {
    name: String,
    crc: u32,
    compressed: Vec<u8>,
    uncompressed_len: u32,
    offset: u32,
}

/// Builds a ZIP archive from `(name, bytes)` pairs, deflating each entry.
pub fn build(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut entries = Vec::with_capacity(files.len());

    for (name, bytes) in files {
        let mut crc = Crc::new();
        crc.update(bytes);
        let crc = crc.sum();

        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(bytes)
            .map_err(|e| format!("zip deflate: {e}"))?;
        let compressed = encoder.finish().map_err(|e| format!("zip deflate: {e}"))?;

        let offset = out.len() as u32;
        write_local_header(&mut out, name, crc, &compressed, bytes.len() as u32);
        out.extend_from_slice(&compressed);

        entries.push(Entry {
            name: name.clone(),
            crc,
            compressed,
            uncompressed_len: bytes.len() as u32,
            offset,
        });
    }

    let central_dir_offset = out.len() as u32;
    for entry in &entries {
        write_central_header(&mut out, entry);
    }
    let central_dir_size = out.len() as u32 - central_dir_offset;

    write_end_record(
        &mut out,
        entries.len() as u16,
        central_dir_size,
        central_dir_offset,
    );

    Ok(out)
}

fn write_local_header(out: &mut Vec<u8>, name: &str, crc: u32, compressed: &[u8], raw_len: u32) {
    out.extend_from_slice(&LOCAL_FILE_HEADER.to_le_bytes());
    out.extend_from_slice(&VERSION_DEFLATE.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // general purpose flags
    out.extend_from_slice(&METHOD_DEFLATE.to_le_bytes());
    out.extend_from_slice(&DOS_TIME.to_le_bytes());
    out.extend_from_slice(&DOS_DATE.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    out.extend_from_slice(&raw_len.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
    out.extend_from_slice(name.as_bytes());
}

fn write_central_header(out: &mut Vec<u8>, entry: &Entry) {
    out.extend_from_slice(&CENTRAL_DIR_HEADER.to_le_bytes());
    out.extend_from_slice(&VERSION_DEFLATE.to_le_bytes()); // version made by
    out.extend_from_slice(&VERSION_DEFLATE.to_le_bytes()); // version needed
    out.extend_from_slice(&0u16.to_le_bytes()); // general purpose flags
    out.extend_from_slice(&METHOD_DEFLATE.to_le_bytes());
    out.extend_from_slice(&DOS_TIME.to_le_bytes());
    out.extend_from_slice(&DOS_DATE.to_le_bytes());
    out.extend_from_slice(&entry.crc.to_le_bytes());
    out.extend_from_slice(&(entry.compressed.len() as u32).to_le_bytes());
    out.extend_from_slice(&entry.uncompressed_len.to_le_bytes());
    out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
    out.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
    out.extend_from_slice(&0u32.to_le_bytes()); // external attributes
    out.extend_from_slice(&entry.offset.to_le_bytes());
    out.extend_from_slice(entry.name.as_bytes());
}

fn write_end_record(out: &mut Vec<u8>, count: u16, central_dir_size: u32, central_dir_offset: u32) {
    out.extend_from_slice(&END_OF_CENTRAL_DIR.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk number
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with central dir
    out.extend_from_slice(&count.to_le_bytes()); // entries on this disk
    out.extend_from_slice(&count.to_le_bytes()); // entries total
    out.extend_from_slice(&central_dir_size.to_le_bytes());
    out.extend_from_slice(&central_dir_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // archive comment length
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn inflate(compressed: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        flate2::read::DeflateDecoder::new(compressed)
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    fn le_u16(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    }

    fn le_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    #[test]
    fn round_trips_entries() {
        let files = vec![
            ("page-1.svg".to_string(), b"<svg>one</svg>".to_vec()),
            ("page-2.svg".to_string(), b"<svg>two</svg>".to_vec()),
        ];
        let archive = build(&files).unwrap();

        // Local-header and EOCD magic, and the EOCD entry count.
        assert_eq!(le_u32(&archive, 0), LOCAL_FILE_HEADER);
        let eocd = archive.len() - 22;
        assert_eq!(le_u32(&archive, eocd), END_OF_CENTRAL_DIR);
        assert_eq!(le_u16(&archive, eocd + 10), files.len() as u16);

        // The first entry's payload sits right after its header + name.
        let name_len = le_u16(&archive, 26) as usize;
        let comp_size = le_u32(&archive, 18) as usize;
        let data_start = 30 + name_len;
        assert_eq!(
            inflate(&archive[data_start..data_start + comp_size]),
            files[0].1
        );
    }
}
